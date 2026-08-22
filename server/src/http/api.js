// api.js — /api/health, /api/events, /api/events/:id, /api/operators (CONTRACT §3)
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Router } from "express";
import { bus } from "../bus/redisBus.js";
import { listEvents, getEvent, listOperators, queueState } from "../dispatch/store.js";
import { listHistory } from "../db/eventsRepo.js";
import { getDispatch, list as listConfig, update as updateConfig, getProcedure, getVideo } from "../config/store.js";
import { startHls, startHlsFromStream, sessionFile, stopHls, keepAlive } from "../playback/hls.js";
import { searchSegment, openDownload, compactToMs, deviceTimeOffsetMs, deviceGopMs } from "../playback/contentmgmt.js";
import { digestGetBuffer, digestRequest } from "../util/digestFetch.js";
import { health as akuvoxHealth, logs as akuvoxLogs, users as akuvoxUsers, faceImage as akuvoxFace, userSave as akuvoxUserSave, userDel as akuvoxUserDel, rawDump as akuvoxRawDump } from "../discovery/akuvox.js";
import { deviceOnline } from "../health/status.js";
import { logs as hikLogs, axStatus as hikAxStatus } from "../discovery/hikvision.js";
import { openDoor, listOutputs, outputStatus } from "../ingest/doors.js";
import { verifyPin, hashPin } from "../auth/pin.js";
import { createSession, destroySession, sessionFromReq, cookieOptions, SESSION_COOKIE } from "../auth/session.js";
import { rateHit, rateReset, clientIp } from "../util/ratelimit.js";
import { auditLog } from "../db/auditRepo.js";
import { config } from "../config.js";

// Rol normalizado del operario (escalonado): agente | supervisor | admin.
const opRole = (o) => {
  const r = String(o?.role || "").toLowerCase();
  if (r === "admin" || r === "administrador") return "admin";
  if (r === "supervisor" || r === "supervisora") return "supervisor";
  return "agente";
};

const router = Router();
const startedAt = Date.now();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EVIDENCE_DIR = path.resolve(__dirname, "..", "..", "data", "evidence");
const AVATAR_DIR = path.resolve(__dirname, "..", "..", "data", "avatars");
// Instalador de la app de escritorio (Electron/Windows). Se publica dejando el
// .exe en data/desktop/ — el endpoint descubre automáticamente el más reciente.
const DESKTOP_DIR = path.resolve(__dirname, "..", "..", "data", "desktop");

// ── Guardia de sesión de operario ───────────────────────────────────────────
// La instancia es pública (internet) con login: las ACCIONES FÍSICAS y el VIDEO
// exigen una sesión de operario (cookie eventos_sid emitida en /auth/login).
// El resto de /api (roster, login, health, groups, sites, ingest lo maneja su
// propio token) sigue accesible. El video se consume como src de <img>/<video>,
// por eso la sesión va por cookie (viaja sola) y no por header.
const PROTECTED = [
  /^\/device\/[^/]+\/relay$/,
  /^\/device\/[^/]+\/outputs/,
  /^\/device\/[^/]+\/ax-status$/,
  /^\/live(\/|$|-direct)/,
  /^\/playback/,
  /^\/snapshot/,
  /^\/mjpeg/,
  /^\/cameras$/,
  /^\/camera\/[^/]+\/(snapshot|mjpeg|live)/,
  /^\/events$/,          // la cola en vivo — no exponer eventos (con datos de sitios) público
  /^\/events\/history$/, // el historial COMPLETO (PG) exige sesión — no exponerlo público
  /^\/events\/[^/]+\/evidence(\/capture)?$/, // metadata de evidencia + captura on-demand
  // (POST con efecto). Las FOTOS en sí siguen en /api/evidence/:file, público (van por <img src>).
  // Datos de cliente / inventario / operativa — NO exponer PII ni topología a anónimos.
  /^\/sites$/,
  /^\/client$/,
  /^\/clientGroups$/,
  /^\/operators$/,
  /^\/groups$/,
  /^\/procedures\//,
  /^\/video-settings$/,
  /^\/camera\/[^/]+\/(info|analytics)$/,
  /^\/cameras\/analytics-flags$/,
  /^\/device\/[^/]+\/(logs|door-events)$/,
  // Gestión de usuarios del portero (tarjetas/PIN/rostros) — credenciales físicas.
  /^\/device\/[^/]+\/akuvox-(users|raw|face|user)/,
  // NOTA: /roster y /avatars/:file quedan PÚBLICOS a propósito (los usa el login
  // antes de autenticar); /health, /auth/*, /desktop/* y /evidence/:file también.
];
// Rutas que exigen rol ELEVADO (supervisor o admin), no sólo sesión: provisión de
// credenciales físicas en el portero (alta/baja de tarjeta/PIN/rostro) y flags de config.
const ELEVATED = [
  /^\/device\/[^/]+\/akuvox-user(\/|$)/, // POST alta / DELETE baja de usuario del portero
  /^\/cameras\/analytics-flags$/,
];
router.use((req, res, next) => {
  if (!PROTECTED.some((rx) => rx.test(req.path))) return next();
  const needsElevated = ELEVATED.some((rx) => rx.test(req.path));
  const s = sessionFromReq(req);
  if (s) {
    req.operator = { id: s.operatorId, name: s.name, role: s.role };
    if (needsElevated && opRole(s) !== "admin" && opRole(s) !== "supervisor") {
      return res.status(403).json({ error: "forbidden", message: "requiere rol supervisor o admin" });
    }
    return next();
  }
  // Alternativa: el token de admin (el panel admin usa X-Admin-Token, no cookie de
  // sesión). Es el privilegio más alto y ya ve todo el inventario, así que vale para
  // leer el historial de eventos. Video/<img> sigue exigiendo cookie (el header no viaja).
  const tok = req.headers["x-admin-token"];
  if (config.adminToken && tok && tok === config.adminToken) {
    req.operator = { id: "admin", name: "Admin", role: "admin" };
    return next();
  }
  return res.status(401).json({ error: "auth_required" });
});

// ── Puertas y relés ────────────────────────────────────────────────────────
// ACCIÓN FÍSICA. La lógica vive en ingest/doors.js, que exige `confirmed` y
// `operatorId` y arma la orden distinta segun la familia del equipo (DS-K por
// AccessControl, AX por SecurityCP, camara/NVR por System/IO). Acá sólo se
// resuelve el dispositivo, se identifica al operario y se registra.

// Compatibilidad: el nombre viejo de la ruta se mantiene y ahora acepta ademas
// `cmd`, `pulseMs` y `dryRun`. Un cliente viejo que sólo mandaba `{output}`
// sigue funcionando, pero ahora DEBE mandar confirmacion — abrir una puerta sin
// que un operario lo pida es exactamente lo que no queremos que pueda pasar.
router.post("/device/:id/relay", async (req, res) => {
  const id = String(req.params.id || "");
  let devices = []; try { devices = listConfig("devices"); } catch {}
  const dev = devices.find((d) => d.id === id);
  if (!dev) return res.status(404).json({ error: "no_device" });
  const b = req.body || {};
  // La identidad SIEMPRE viene de la sesión (req.operator lo fija el guard PROTECTED),
  // nunca del body — no se puede falsificar quién abrió la puerta.
  const operatorId = (req.operator && req.operator.id) || null;
  const operatorName = (req.operator && req.operator.name) || null;
  const output = b.output != null ? b.output : 1;
  const cmd = b.cmd || "open";
  try {
    const r = await openDoor(dev, {
      output, cmd, operatorId,
      confirmed: b.confirmed === true,
      pulseMs: b.pulseMs != null ? Number(b.pulseMs) : undefined,
      dryRun: b.dryRun === true,
    });
    // Bitácora durable de no-repudio (excepto dryRun): quién, qué equipo, salida, resultado.
    if (b.dryRun !== true) {
      auditLog({
        action: "door_open", operatorId, operatorName,
        deviceId: dev.id, deviceName: dev.name || null,
        detail: `cmd=${cmd} output=${output}`,
        result: r && r.ok === false ? "fail" : "ok",
        ip: clientIp(req),
      });
    }
    if (r.ok === false) return res.status(502).json({ error: "relay_failed", ...r });
    res.json(r);
  } catch (e) {
    if (b.dryRun !== true) {
      auditLog({
        action: "door_open", operatorId, operatorName,
        deviceId: dev.id, deviceName: dev.name || null,
        detail: `cmd=${cmd} output=${output}`, result: `error:${e.message}`, ip: clientIp(req),
      });
    }
    const code = ["not_confirmed", "no_operator", "bad_output", "no_creds"].includes(e.message) ? 400 : 502;
    res.status(code).json({ error: e.message });
  }
});

// Qué salidas/puertas tiene el equipo, para que la UI no pida un numero a ciegas.
router.get("/device/:id/outputs", async (req, res) => {
  const id = String(req.params.id || "");
  let devices = []; try { devices = listConfig("devices"); } catch {}
  const dev = devices.find((d) => d.id === id);
  if (!dev) return res.status(404).json({ error: "no_device" });
  try {
    res.json(await listOutputs(dev));
  } catch (e) {
    res.status(502).json({ error: "outputs_failed", message: e.message });
  }
});

// Estado de una salida (sólo lo expone la familia `io`).
router.get("/device/:id/outputs/:out/status", async (req, res) => {
  const id = String(req.params.id || "");
  let devices = []; try { devices = listConfig("devices"); } catch {}
  const dev = devices.find((d) => d.id === id);
  if (!dev) return res.status(404).json({ error: "no_device" });
  if (!/^[\w-]+$/.test(String(req.params.out))) return res.status(400).json({ error: "bad_output" });
  try {
    res.json(await outputStatus(dev, req.params.out));
  } catch (e) {
    res.status(502).json({ error: "status_failed", message: e.message });
  }
});

// Estado en vivo de un panel de alarma AX (SecurityCP): salud del host
// (batería / red / corriente / sabotaje), subsistemas (armado), zonas (apertura
// de puerta/ventana, alarma, sabotaje, batería) y relés (on/off real). SOLO
// LECTURA — no acciona nada físico. La UI del panel lo consulta en intervalos.
router.get("/device/:id/ax-status", async (req, res) => {
  const id = String(req.params.id || "");
  let devices = []; try { devices = listConfig("devices"); } catch {}
  const dev = devices.find((d) => d.id === id);
  if (!dev) return res.status(404).json({ error: "no_device" });
  if (!dev.ip || !dev.username) return res.status(400).json({ error: "no_creds" });
  try {
    const st = await hikAxStatus({
      host: dev.ip, port: Number(dev.isapiPort) || 80, https: !!dev.isapiHttps,
      user: dev.username, pass: dev.password || "",
    });
    res.json(st);
  } catch (e) {
    res.status(502).json({ error: "ax_status_failed", message: e.message });
  }
});

// Eventos de puerta/apertura recientes de un dispositivo de alarma, tomados del
// registro de eventos de EventOS (lo que ya llegó por alertStream/webhook). La
// UI del panel los muestra como "eventos de puerta abierta".
router.get("/device/:id/door-events", (req, res) => {
  const id = String(req.params.id || "");
  let devices = []; try { devices = listConfig("devices"); } catch {}
  const dev = devices.find((d) => d.id === id);
  if (!dev) return res.status(404).json({ error: "no_device" });
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 12));
  const DOOR_RE = /door|puerta|magnet|contact|open|apertura|zone|zona|intrus|tamper|sabot/i;
  let list = [];
  try { list = listEvents({ limit: 300 }); } catch { list = []; }
  if (!Array.isArray(list)) list = (list && list.events) || [];
  const mine = list.filter((e) => e && (e.deviceId === id || (e.source && (e.source.deviceId === id || e.source.id === id)) || (dev.name && e.source && e.source.name === dev.name)))
    .filter((e) => DOOR_RE.test(`${e.type || ""} ${e.category || ""} ${(e.source && e.source.name) || ""}`))
    .slice(0, limit)
    .map((e) => ({ id: e.id, type: e.type, ts: e.deviceTs || e.ts, status: e.status, priority: e.priority, name: e.source && e.source.name }));
  res.json({ events: mine });
});

// Evidencia: galeria por caso (lista de frames del evento).
router.get("/events/:id/evidence", (req, res) => {
  const id = String(req.params.id || "");
  if (!/^[\w-]+$/.test(id)) return res.status(400).json({ error: "bad_id" });
  let files = [];
  try { files = fs.readdirSync(EVIDENCE_DIR); } catch { files = []; }
  const esc = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^${esc}(-\\d+)?\\.jpg$`);
  const images = files.filter((f) => re.test(f))
    .map((f) => { let m = 0; try { m = fs.statSync(path.join(EVIDENCE_DIR, f)).mtimeMs; } catch {} return { url: `/api/evidence/${f}`, ts: m }; })
    .sort((a, b) => a.ts - b.ts);
  res.json({ images });
});

// Evidencia: captura on-demand de un nuevo frame (snapshot ISAPI de la camara).
router.post("/events/:id/evidence/capture", async (req, res) => {
  const id = String(req.params.id || "");
  if (!/^[\w-]+$/.test(id)) return res.status(400).json({ error: "bad_id" });
  const ev = getEvent(id);
  const deviceId = (ev && ev.source && ev.source.deviceId) || (req.body && req.body.deviceId);
  if (!deviceId) return res.status(400).json({ error: "no_device" });
  let devices = []; try { devices = listConfig("devices"); } catch {}
  const dev = devices.find((d) => d.id === deviceId);
  if (!dev || !dev.ip || !dev.isapiPort || !dev.username) return res.status(400).json({ error: "no_device_creds" });
  const ch = Number(dev.channel) > 0 ? Number(dev.channel) : 1;
  let buf = null;
  try {
    const r = await digestGetBuffer({ host: dev.ip, port: Number(dev.isapiPort), https: !!dev.isapiHttps,
      path: `/ISAPI/Streaming/channels/${ch}01/picture`, user: dev.username, pass: dev.password || "", timeoutMs: 4000 });
    if (r.status === 200 && r.buffer && r.buffer.length > 200 && /image/i.test(r.contentType || "")) buf = r.buffer;
  } catch {}
  if (!buf) return res.status(502).json({ error: "capture_failed" });
  let files = []; try { files = fs.readdirSync(EVIDENCE_DIR); } catch {}
  const esc = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^${esc}-(\\d+)\\.jpg$`);
  let maxN = 0; for (const f of files) { const m = re.exec(f); if (m) maxN = Math.max(maxN, Number(m[1])); }
  const name = `${id}-${maxN + 1}.jpg`;
  try { fs.mkdirSync(EVIDENCE_DIR, { recursive: true }); fs.writeFileSync(path.join(EVIDENCE_DIR, name), buf); }
  catch (e) { return res.status(500).json({ error: "save_failed", message: e.message }); }
  res.json({ url: `/api/evidence/${name}` });
});

// Sirve la foto de evidencia de un evento (solo lectura, público). Valida el
// nombre para impedir path traversal; 404 si no existe.
router.get("/evidence/:file", (req, res) => {
  const name = String(req.params.file || "");
  if (!/^[\w.-]+\.jpg$/.test(name)) return res.status(400).end();
  const fp = path.join(EVIDENCE_DIR, name);
  if (!fp.startsWith(EVIDENCE_DIR + path.sep) || !fs.existsSync(fp)) return res.status(404).end();
  res.set("Content-Type", "image/jpeg");
  res.set("Cache-Control", "public, max-age=86400");
  fs.createReadStream(fp).pipe(res);
});

// ── Playback NVR (RTSP → HLS) ───────────────────────────────────────────────
// Inicia una sesión de reproducción. La URL RTSP la CONSTRUYE el server desde la
// config del dispositivo (no se acepta del cliente) + tiempos saneados.
const HIK_TIME = /^\d{8}T\d{6}Z$/; // YYYYMMDDThhmmssZ (formato ISAPI)
// Reescribe starttime/endtime de un playbackURI de ISAPI (reloj LOCAL del NVR con
// `Z` engañoso) para que el download arranque en el instante deseado, no al inicio
// del archivo. `ms` son ms "local-as-UTC" (mismo espacio que devuelve compactToMs).
const msToHik = (ms) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
function withPbTimes(uri, startMs, endMs) {
  return String(uri)
    .replace(/starttime=\d{8}T\d{6}Z/i, `starttime=${msToHik(startMs)}`)
    .replace(/endtime=\d{8}T\d{6}Z/i, `endtime=${msToHik(endMs)}`);
}
router.post("/playback", (req, res) => {
  const body = req.body || {};
  const deviceId = String(body.deviceId || "");
  const start = String(body.start || "");
  const end = String(body.end || "");
  let devices = [];
  try { devices = listConfig("devices"); } catch { /* store */ }
  const dev = devices.find((d) => d.id === deviceId);
  if (!dev) return res.status(404).json({ error: "no_device" });
  // Base con credenciales (campos del dispositivo) → flujo principal.
  let rtsp = deviceLiveRtsp(dev, "main");
  if (!rtsp) return res.status(400).json({ error: "sin_rtsp", message: "El dispositivo no tiene RTSP/credenciales." });
  // Playback por tiempo (Hik ISAPI) si start/end válidos; si no, vista en vivo.
  // Este NVR usa /Streaming/channels/<ch>0X?starttime&endtime (UTC, con Z).
  // Usamos el SUBflujo (02): el principal de estas cámaras llega corrupto por el
  // NAT y el navegador no lo decodifica. Ojo: 'tracks/' da 400 en estos DS-9632NI.
  if (HIK_TIME.test(start) && HIK_TIME.test(end)) {
    const ch = Number(dev.channel) > 0 ? Number(dev.channel) : 1;
    const root = (rtsp.match(/^(rtsps?:\/\/[^/]+)/i) || [, rtsp])[1];
    rtsp = `${root}/Streaming/channels/${ch}02?starttime=${start}&endtime=${end}`;
  }
  try {
    const s = startHls(rtsp);
    res.json({ id: s.id, url: s.url });
  } catch (e) {
    res.status(500).json({ error: "playback_failed", message: e.message });
  }
});

// Playlist mínima "calentando": válida y vacía para que hls.js espere segmentos
// sin disparar 404 mientras ffmpeg genera el primer .ts (~2-3 s).
const WARMUP_M3U8 = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n";
router.get("/playback/:id/:file", (req, res) => {
  const file = String(req.params.file || "");
  const fp = sessionFile(req.params.id, file);
  if (!fp) return res.status(404).end(); // sesión inexistente (expulsada/parada)
  if (!fs.existsSync(fp)) {
    if (file.endsWith(".m3u8")) {
      res.set("Content-Type", "application/vnd.apple.mpegurl");
      res.set("Cache-Control", "no-cache");
      return res.end(WARMUP_M3U8);
    }
    return res.status(404).end(); // .ts aún no escrito
  }
  res.set("Content-Type", file.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp2t");
  res.set("Cache-Control", "no-cache");
  fs.createReadStream(fp).pipe(res);
});

router.delete("/playback/:id", (req, res) => { stopHls(req.params.id); res.json({ ok: true }); });

// Mantener viva una sesión de vivo (heartbeat de las tiles del muro).
router.post("/playback/:id/keepalive", (req, res) => { res.json({ ok: keepAlive(req.params.id) }); });

// ── Vista EN VIVO (RTSP → HLS) ──────────────────────────────────────────────
// Construye el RTSP con credenciales desde la config del dispositivo (nunca del
// cliente). `quality`: 'sub' (subflujo, ligero, por defecto) | 'main'. Reúsa la
// sesión por (device,quality) para no duplicar ffmpeg si varios miran lo mismo.
// Plantilla RTSP por fabricante (config video). Hikvision/vacío → null para
// conservar la ruta histórica hardcodeada (retrocompatible).
function rtspTemplateFor(vendor) {
  const v = String(vendor || "").trim().toLowerCase();
  if (!v || v === "hikvision") return null;
  try {
    const hit = (getVideo().rtspTemplates || []).find((t) => String(t.vendor || "").trim().toLowerCase() === v);
    return hit && (hit.main || hit.sub) ? hit : null;
  } catch { return null; }
}
function deviceLiveRtsp(dev, quality) {
  const suffix = quality === "main" ? "01" : "02";
  const ch = Number(dev.channel) > 0 ? Number(dev.channel) : 1;
  if (dev.username && dev.rtspPort && dev.ip) {
    const u = encodeURIComponent(dev.username);
    const p = encodeURIComponent(dev.password || "");
    const root = `rtsp://${u}:${p}@${dev.ip}:${dev.rtspPort}`;
    // Fabricante con plantilla propia (p. ej. Tiandy `/{ch}/1`): usarla.
    const tpl = rtspTemplateFor(dev.vendor);
    if (tpl) {
      const raw = (quality === "main" ? tpl.main : (tpl.sub || tpl.main)) || "";
      return root + raw.replace(/\{ch\}/g, String(ch));
    }
    return `${root}/Streaming/channels/${ch}${suffix}`;
  }
  // Fallback: rtspUrl ya guardada (main); para sub cambia el sufijo 01→02.
  if (dev.rtspUrl && /^rtsps?:\/\//i.test(dev.rtspUrl)) {
    return quality === "main"
      ? dev.rtspUrl.trim()
      : dev.rtspUrl.trim().replace(/(\/channels\/\d*?)01(?=$|\?|\/)/i, `$1${suffix}`);
  }
  return null;
}
// RTSP DIRECTO a la cámara (no al NVR). El restream del NVR corrompe el H264;
// el stream directo de la cámara (cuando hay VPN a su red) llega LIMPIO a 25fps.
// `dev.camIp` se setea desde el InputProxy del NVR (canal→IP de cámara).
function deviceDirectRtsp(dev, quality) {
  if (!dev || !dev.username) return null;
  const proxied = (dev.tags || []).some((t) => /^nvr:/i.test(t));
  // Host DIRECTO: camIp si está; si no, la ip del device pero SOLO si NO está detrás
  // de un NVR (una cámara standalone tiene su propia ip = directo y limpio; una de
  // NVR sin camIp iría al restream corrupto → null para que caiga a MJPEG).
  const host = dev.camIp || (proxied ? null : dev.ip);
  if (!host) return null;
  // camIp = IP DIRECTA de la cámara (red interna vía VPN) → RTSP estándar 554.
  // Pero si camIp coincide con la ip pública (equipo con NAT, p. ej. un portero
  // Akuvox mapeado a :10554), hay que usar el rtspPort configurado, no 554.
  const port = (dev.camIp && dev.camIp !== dev.ip) ? 554 : (Number(dev.rtspPort) || 554);
  const suffix = quality === "main" ? "01" : "02";
  const u = encodeURIComponent(dev.username);
  const p = encodeURIComponent(dev.password || "");
  const root = `rtsp://${u}:${p}@${host}:${port}`;
  // Fabricante con plantilla propia (p. ej. Tiandy `/{ch}/1`): usarla con el
  // canal del equipo (si es acceso directo a la cámara, canal = 1).
  // Canal: si `camIp` es una IP DISTINTA a la del device, es acceso directo a la
  // cámara (1 solo canal → 1). En cambio, si el host es el propio NVR (camIp
  // ausente o == ip), hay que pedir el CANAL del device — si no, todos los
  // canales del NVR devuelven el mismo (canal 1) y se ve la misma imagen repetida.
  const directCam = dev.camIp && dev.camIp !== dev.ip;
  const ch = directCam ? 1 : (Number(dev.channel) > 0 ? Number(dev.channel) : 1);
  const tpl = rtspTemplateFor(dev.vendor);
  if (tpl) {
    const raw = (quality === "main" ? tpl.main : (tpl.sub || tpl.main)) || "";
    return root + raw.replace(/\{ch\}/g, String(ch));
  }
  return `${root}/Streaming/Channels/${ch}${suffix}`;
}
// Vivo por go2rtc (MSE). Elige un RTSP alcanzable (directo si la camIp responde,
// si no por el NVR). Antes devolvía 404 sin camIp y el front caía a MJPEG (fotos).
// (tcpReachable está definida más abajo en este módulo.)
router.post("/live-direct", async (req, res) => {
  const body = req.body || {};
  const deviceId = String(body.deviceId || "");
  const quality = body.quality === "main" ? "main" : "sub";
  let devices = [];
  try { devices = listConfig("devices"); } catch { /* store */ }
  const dev = devices.find((d) => d.id === deviceId);
  if (!dev) return res.status(404).json({ error: "no_device" });
  // VIVO FLUIDO SIEMPRE por RTSP → go2rtc (MSE). Si hay IP directa a la cámara, se
  // usa (stream más limpio); si no, se usa el RTSP del NVR con el CANAL del device.
  // Antes, sin camIp, esto devolvía 404 y el front caía a MJPEG (fotos): por eso
  // "no era fluido". Ahora el NVR también sale por go2rtc = flujo real, no fotos.
  // VIVO FLUIDO: elegir un RTSP que el server REALMENTE alcance. La `camIp`
  // (acceso directo a la cámara) suele ser una IP LAN detrás del NVR que el
  // server NO rutea → ffmpeg se cuelga y el vivo cae a fotos. Antes de usarla,
  // probamos TCP a su puerto; si no responde, usamos el RTSP por el NVR (dev.ip,
  // que es la IP alcanzable — la misma del snapshot) con el canal del device.
  // FUENTE DE VIDEO (por cámara): 'direct' fuerza acceso directo, 'nvr' fuerza el
  // restream del NVR, 'auto' (default) sondea camIp y cae al NVR si no responde.
  const liveSource = String(dev.liveSource || "auto").toLowerCase();
  const direct = deviceDirectRtsp(dev, quality);
  let rtsp = null, useAudio = false;
  if (liveSource === "direct") {
    rtsp = direct; useAudio = !!direct;                 // directo explícito
  } else if (liveSource === "nvr") {
    rtsp = deviceLiveRtsp(dev, quality); useAudio = false; // por NVR explícito
  } else {
    // AUTO: la camIp suele ser una IP LAN detrás del NVR que el server NO rutea →
    // ffmpeg se cuelga y el vivo cae a fotos. Sondeamos TCP antes de usarla; si no
    // responde, vamos por el NVR (dev.ip alcanzable — la misma del snapshot).
    if (direct && dev.camIp) {
      const camPort = (dev.camIp !== dev.ip) ? 554 : (Number(dev.rtspPort) || 554);
      if (await tcpReachable(dev.camIp, camPort, 1500)) { rtsp = direct; useAudio = true; }
    } else if (direct && !dev.camIp) {
      rtsp = direct; useAudio = true; // directo sin camIp (cámara standalone por su ip)
    }
    if (!rtsp) rtsp = deviceLiveRtsp(dev, quality); // camino por NVR (video-only)
  }
  if (!rtsp) return res.status(404).json({ error: "no_rtsp" });
  try {
    // El nombre incluye la CALIDAD → main y sub son streams separados (permite
    // alternar en vivo sin pisar uno con otro).
    // Transcodificar (re-encode) en vez de copy: las cámaras H.264+/SmartCodec
    // de cesimco emiten un SPS que el navegador rechaza por MSE ([VideoRTC] Video
    // error). ffmpeg reescribe un SPS válido → vivo limpio. (copy fallaba en ellas.)
    // Acceso directo a cámara (alcanzable) → con audio (probado). Restream por NVR
    // → video-only (robusto: no se cuelga si el canal no tiene audio).
    // MODO DE PROCESAMIENTO (por cámara): 'copy' = go2rtc reenvía el RTSP nativo SIN
    // ffmpeg (CPU ~0, menor latencia, más canales simultáneos) — ideal para cámaras
    // que decodifican bien por MSE. 'transcode' (default) = ffmpeg reescribe el SPS
    // (necesario en fisheye/H.264+ que el navegador rechaza). Fine-tuning de escala.
    const videoMode = String(dev.videoMode || "transcode").toLowerCase();
    // VAAPI (iGPU) decodifica bien el MAINSTREAM, pero el decodificador HW de HEVC
    // de la Gen9 se cuelga con algunos SUBFLUJOS H.265 (PPS id out of range / "hardware
    // accelerator failed to decode picture") → go2rtc devuelve 500. El subflujo es de
    // baja resolución: transcodificarlo por SOFTWARE es barato y tolera esos glitches.
    // Por eso: hw='vaapi' solo en main; el sub usa transcode por software.
    const useHw = videoMode === "hw" && quality === "main";
    const src = videoMode === "copy" ? rtsp
      : useHw ? go2rtcTranscodeSrc(rtsp, { audio: useAudio, hw: "vaapi" })
      : go2rtcTranscodeSrc(rtsp, { audio: useAudio });
    const name = await registerGo2rtc(`cam_${deviceId}_${quality}`, src);
    // Al cambiar de calidad (main↔sub), liberar el stream de la OTRA calidad: si no,
    // go2rtc deja vivo el ffmpeg anterior consumiendo una conexión RTSP del NVR (que
    // limita conexiones concurrentes) → el switch "no cambia" o satura el grabador.
    const other = quality === "main" ? "sub" : "main";
    try { await fetch(`http://127.0.0.1:1984/api/streams?src=${encodeURIComponent(`cam_${deviceId}_${other}`)}`, { method: "DELETE" }); } catch { /* no existía */ }
    res.json({ name });
  } catch (e) {
    res.status(502).json({ error: "go2rtc_failed", message: e.message });
  }
});
router.post("/live", (req, res) => {
  const body = req.body || {};
  const deviceId = String(body.deviceId || "");
  let video = {}; try { video = getVideo(); } catch { /* store */ }
  const quality = (body.quality || video.quality) === "main" ? "main" : "sub";
  let devices = [];
  try { devices = listConfig("devices"); } catch { /* store */ }
  const dev = devices.find((d) => d.id === deviceId);
  if (!dev) return res.status(404).json({ error: "no_device" });
  const rtsp = deviceLiveRtsp(dev, quality);
  if (!rtsp) return res.status(400).json({ error: "sin_rtsp", message: "El dispositivo no tiene RTSP/credenciales." });
  try {
    const s = startHls(rtsp, { key: `live:${deviceId}:${quality}`, transport: video.rtspTransport });
    res.json({ id: s.id, url: s.url });
  } catch (e) {
    res.status(500).json({ error: "live_failed", message: e.message });
  }
});

// ── Vivo vía go2rtc TRANSCODIFICADO (MSE) ───────────────────────────────────
// Las cámaras Hikvision fisheye de cesimco emiten un H264 con SPS malformado
// (crop values invalid / sps_id out of range): NINGÚN decodificador de navegador
// lo acepta (MSE y WebRTC dan PIPELINE_ERROR_DECODE aunque los bytes lleguen).
// ffmpeg decodifica y RE-ENCODA con un SPS válido → reproduce limpio por MSE
// (que viaja por WebSocket/HTTP, sin depender de ICE/UDP). Registramos un stream
// `live_<deviceId>` on-demand (go2rtc solo lanza ffmpeg cuando hay consumidor).
function go2rtcTranscodeSrc(rtsp, { audio = true, hw = null } = {}) {
  // #video=h264 (libx264) reescribe el SPS. El audio es OPCIONAL: en el restream
  // del NVR muchos canales NO traen pista de audio, y pedir #audio=aac puede
  // COLGAR el arranque de ffmpeg esperando un stream que no existe → el vivo
  // "no arranca". Video-only es más robusto y de menor latencia para cámaras de
  // seguridad. Se mantiene el audio solo donde se sabe que ayuda (acceso directo).
  //
  // hw = 'vaapi' → go2rtc transcodifica por la iGPU (decode+encode en GPU): CPU ~0
  // y escala a muchos más canales. Requiere /dev/dri en el CT + driver (iHD) +
  // LIBVA_DRIVER_NAME en el servicio go2rtc. NO usar en cámaras con SPS roto
  // (fisheye) — esas quedan en 'transcode' (libx264 en CPU, que sanea el SPS).
  const hwTag = hw ? `#hardware=${hw}` : "";
  return audio ? `ffmpeg:${rtsp}#video=h264#audio=aac${hwTag}` : `ffmpeg:${rtsp}#video=h264${hwTag}`;
}
async function registerGo2rtc(name, src) {
  // IMPORTANTE: go2rtc ACUMULA fuentes en cada PUT y NO se reinicia en cada deploy.
  // Si el stream ya existía con una fuente vieja/fallida (p. ej. una directa que
  // daba 404, o audio que colgaba), un PUT nuevo agrega la fuente actual PERO
  // go2rtc puede seguir intentando la vieja primero → "no arranca / no fluido".
  // Borrar el stream antes de crearlo garantiza que tenga EXACTAMENTE la fuente
  // actual. Si no existía, el DELETE es un no-op inocuo.
  try { await fetch(`http://127.0.0.1:1984/api/streams?src=${encodeURIComponent(name)}`, { method: "DELETE" }); } catch { /* no existía */ }
  const r = await fetch(`http://127.0.0.1:1984/api/streams?name=${encodeURIComponent(name)}&src=${encodeURIComponent(src)}`, { method: "PUT" });
  if (!r.ok) throw new Error(`go2rtc ${r.status}`);
  return name;
}
// Frame JPEG del vivo vía go2rtc (snapshot de equipos SIN ISAPI, p. ej. Tiandy).
async function fetchGo2rtcFrame(dev) {
  const rtsp = deviceLiveRtsp(dev, "sub") || deviceLiveRtsp(dev, "main");
  if (!rtsp) return null;
  const url = `http://127.0.0.1:1984/api/frame.jpeg?src=${encodeURIComponent(`ffmpeg:${rtsp}#video=h264`)}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 9000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    return buf.length > 200 ? buf : null;
  } catch { return null; } finally { clearTimeout(t); }
}
// ¿Responde el puerto TCP? (reachability para equipos sin ISAPI → online/offline).
function tcpReachable(host, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok) => { if (done) return; done = true; try { sock.destroy(); } catch { /* noop */ } resolve(ok); };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => finish(true));
    sock.once("timeout", () => finish(false));
    sock.once("error", () => finish(false));
    try { sock.connect(port, host); } catch { finish(false); }
  });
}
router.post("/live-stream", async (req, res) => {
  const body = req.body || {};
  const deviceId = String(body.deviceId || "");
  const quality = body.quality === "main" ? "main" : "sub";
  let devices = [];
  try { devices = listConfig("devices"); } catch { /* store */ }
  const dev = devices.find((d) => d.id === deviceId);
  if (!dev) return res.status(404).json({ error: "no_device" });
  const rtsp = deviceLiveRtsp(dev, quality);
  if (!rtsp) return res.status(400).json({ error: "sin_rtsp", message: "El dispositivo no tiene RTSP/credenciales." });
  try {
    const name = await registerGo2rtc(`live_${deviceId}`, go2rtcTranscodeSrc(rtsp));
    res.json({ name });
  } catch (e) {
    res.status(502).json({ error: "go2rtc_failed", message: e.message });
  }
});

// FUENTE DE PLAYBACK (por cámara): 'nvr' (default) → las grabaciones se leen del
// NVR (dev.ip, alcanzable). 'direct' → de la propia cámara (SD/edge) por su camIp.
// Devuelve una COPIA con el host correcto (nunca muta el objeto del store).
function playbackDev(dev) {
  const src = String(dev.playbackSource || "nvr").toLowerCase();
  if (src === "direct" && dev.camIp) return { ...dev, ip: dev.camIp };
  return dev;
}

// ── Playback de grabación vía go2rtc ────────────────────────────────────────
// Registra (o actualiza) un stream `pb_<deviceId>` en go2rtc con el RTSP de la
// grabación (subflujo + starttime/endtime, UTC con Z) y devuelve su nombre para
// que el cliente lo reproduzca por MSE. El RTSP (con credenciales) lo construye
// el server; nunca se expone al cliente. TRANSCODIFICADO (mismo motivo del SPS).
router.post("/playback-stream", async (req, res) => {
  const body = req.body || {};
  const deviceId = String(body.deviceId || "");
  const start = String(body.start || ""), end = String(body.end || "");
  if (!HIK_TIME.test(start) || !HIK_TIME.test(end)) return res.status(400).json({ error: "bad_time" });
  let devices = [];
  try { devices = listConfig("devices"); } catch { /* store */ }
  const found = devices.find((d) => d.id === deviceId);
  if (!found) return res.status(404).json({ error: "no_device" });
  const dev = playbackDev(found);
  const base = deviceLiveRtsp(dev, "main");
  if (!base) return res.status(400).json({ error: "sin_rtsp" });
  const root = (base.match(/^(rtsps?:\/\/[^/]+)/i) || [, base])[1];
  const ch = Number(dev.channel) > 0 ? Number(dev.channel) : 1;
  const rtsp = `${root}/Streaming/channels/${ch}02?starttime=${start}&endtime=${end}`;
  const name = `pb_${deviceId}`;
  try {
    await registerGo2rtc(name, go2rtcTranscodeSrc(rtsp));
    res.json({ name });
  } catch (e) {
    res.status(502).json({ error: "go2rtc_failed", message: e.message });
  }
});

// Playback por HLS transcodificado (mismo pipeline que el vivo, sin go2rtc → sin
// el "Empty src" de MSE con el H264 corrupto). Devuelve la m3u8 de la sesión.
router.post("/playback-hls", async (req, res) => {
  const body = req.body || {};
  const deviceId = String(body.deviceId || "");
  const start = String(body.start || ""), end = String(body.end || "");
  if (!HIK_TIME.test(start) || !HIK_TIME.test(end)) return res.status(400).json({ error: "bad_time" });
  let devices = [];
  try { devices = listConfig("devices"); } catch { /* store */ }
  const found = devices.find((d) => d.id === deviceId);
  if (!found) return res.status(404).json({ error: "no_device" });
  const dev = playbackDev(found);
  // Playback de equipos SIN ISAPI (Tiandy/ONVIF): el NVR reproduce por RTSP con
  // rango ?begin&end en HORA LOCAL del equipo. startHls re-encoda a H264 → el H265
  // de Tiandy reproduce en el navegador. Devuelve {id,url} como el playback Hik.
  if (rtspTemplateFor(dev.vendor)) {
    const base = deviceLiveRtsp(dev, "main");
    if (!base) return res.status(400).json({ error: "sin_rtsp" });
    const tzMin = Number.isFinite(Number(process.env.EVENTOS_NVR_TZ_OFFSET_MIN)) ? Number(process.env.EVENTOS_NVR_TZ_OFFSET_MIN) : -180;
    const toLocal = (h) => {
      const d = new Date(Date.UTC(+h.slice(0, 4), +h.slice(4, 6) - 1, +h.slice(6, 8), +h.slice(9, 11), +h.slice(11, 13), +h.slice(13, 15)) + tzMin * 60000);
      const p = (n) => String(n).padStart(2, "0");
      return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
    };
    const rtsp = `${base}?begin=${toLocal(start)}&end=${toLocal(end)}`;
    try {
      const s = startHls(rtsp, { key: `pb:${deviceId}:${start}`, transport: "tcp" });
      return res.json({ id: s.id, url: s.url, segStartUtcMs: compactToMs(start) });
    } catch (e) {
      return res.status(500).json({ error: "playback_failed", message: e.message });
    }
  }
  if (!dev.ip || !dev.isapiPort || !dev.username) return res.status(400).json({ error: "sin_isapi" });
  const ch = Number(dev.channel) > 0 ? Number(dev.channel) : 1;
  const startMs = compactToMs(start), endMs = compactToMs(end);
  if (!Number.isFinite(startMs)) return res.status(400).json({ error: "bad_time" });
  try {
    // SEEK EXACTO SERVER-SIDE (como iVMS). Verificado en campo (DS-7616 Delbau):
    //  · El DOWNLOAD de ContentMgmt IGNORA el `starttime` → siempre arranca al INICIO
    //    del archivo (probado: frame pedido a 12:45 devolvía 12:41 = inicio de archivo).
    //    Por eso la línea de tiempo quedaba corrida por TODO el offset dentro del
    //    archivo (minutos), no por 1 GOP.
    //  · El RTSP de `Streaming/channels/<ch>0X` llega indecodificable (SPS roto).
    //  · PERO `Streaming/tracks/<ch>01?starttime&endtime` HONRA el starttime: el NVR
    //    hace el seek server-side y entrega el flujo DESDE ese instante, y decodifica
    //    limpio (frame pedido a 12:57 devolvía 12:57). Ese es el camino de precisión.
    // ZONA HORARIA: las grabaciones se direccionan en hora LOCAL del NVR → convertimos
    // el instante UTC pedido con el offset del equipo (deviceTimeOffsetMs).
    const off = await deviceTimeOffsetMs(dev);
    const sMs = startMs + off, eMs = endMs + off;
    // Verificación liviana de que hay grabación (para un "no_recording" claro).
    const seg = await searchSegment(dev, ch * 100 + 1, sMs - 60000, eMs);
    if (!seg) return res.status(404).json({ error: "no_recording", message: "No hay grabación en ese instante." });
    const baseRtsp = deviceLiveRtsp(dev, "main");
    if (!baseRtsp) return res.status(400).json({ error: "sin_rtsp" });
    const root = (baseRtsp.match(/^(rtsps?:\/\/[^/]+)/i) || [, baseRtsp])[1];
    const winMs = Math.min(30 * 60000, Math.max(60000, eMs - sMs));
    const sLoc = msToHik(sMs), eLoc = msToHik(sMs + winMs);
    const rtsp = `${root}/Streaming/tracks/${ch * 100 + 1}?starttime=${sLoc}&endtime=${eLoc}`;
    const s = startHls(rtsp, { key: `pb:${deviceId}:${start}`, transport: "tcp" });
    // El NVR arranca EXACTO en el instante pedido → currentTime 0 = T (sin seek fino).
    res.json({
      id: s.id, url: s.url,
      segStartMs: startMs,          // currentTime 0 = instante pedido (UTC)
      requestedMs: startMs,
      seekOffsetSec: 0,
      coverEndMs: startMs + winMs,
    });
  } catch (e) {
    res.status(502).json({ error: "pb_failed", message: e.message });
  }
});


// ── Descarga de CLIP de grabación (MP4) ──────────────────────────────────────
// Baja el segmento que cubre el instante (ContentMgmt MPEG-PS), recorta `dur`
// segundos desde el instante pedido (con corrección de zona horaria del NVR) y
// lo entrega como MP4 fragmentado descargable. Transcode a H.264 baseline →
// arranque limpio y reproducible en cualquier reproductor.
router.get("/playback-clip", async (req, res) => {
  const deviceId = String(req.query.deviceId || "");
  const start = String(req.query.start || "");
  const dur = Math.min(300, Math.max(5, Number(req.query.dur) || 60));
  if (!HIK_TIME.test(start)) return res.status(400).json({ error: "bad_time" });
  let devices = [];
  try { devices = listConfig("devices"); } catch { /* store */ }
  const dev = devices.find((d) => d.id === deviceId);
  if (!dev) return res.status(404).json({ error: "no_device" });
  if (!dev.ip || !dev.isapiPort || !dev.username) return res.status(400).json({ error: "sin_isapi" });
  const ch = Number(dev.channel) > 0 ? Number(dev.channel) : 1;
  const startMs = compactToMs(start);
  if (!Number.isFinite(startMs)) return res.status(400).json({ error: "bad_time" });
  try {
    const off = await deviceTimeOffsetMs(dev);
    const sMs = startMs + off;
    const seg = await searchSegment(dev, ch * 100 + 1, sMs - 60000, sMs + dur * 1000);
    if (!seg) return res.status(404).json({ error: "no_recording", message: "No hay grabación en ese instante." });
    const ss = Math.max(0, (sMs - seg.segStartMs) / 1000);
    const dl = await openDownload(dev, seg.uri);
    const fname = `${(dev.name || "camara").replace(/[^\w.-]+/g, "_")}-${start}.mp4`;
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", `attachment; filename="${fname}"`);
    const args = [
      "-nostdin", "-fflags", "+genpts", "-i", "pipe:0",
      "-ss", ss.toFixed(2), "-t", String(dur), "-an",
      "-c:v", "libx264", "-preset", "veryfast", "-profile:v", "baseline", "-pix_fmt", "yuv420p",
      "-movflags", "frag_keyframe+empty_moov+default_base_moof", "-f", "mp4", "pipe:1",
    ];
    const proc = spawn("ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"] });
    let errTail = "";
    proc.stderr.on("data", (d) => { errTail = (errTail + d.toString()).slice(-600); });
    proc.stdin.on("error", () => { /* EPIPE */ });
    dl.stream.on("error", () => { try { proc.stdin.end(); } catch { /* noop */ } });
    dl.stream.on("end", () => { try { proc.stdin.end(); } catch { /* noop */ } });
    dl.stream.pipe(proc.stdin);
    proc.stdout.pipe(res);
    const cleanup = () => { try { dl.abort && dl.abort(); } catch { /* noop */ } try { proc.kill("SIGKILL"); } catch { /* noop */ } };
    res.on("close", cleanup);
    proc.on("exit", (code) => { if (code && code !== 255 && code !== 0) console.warn(`[clip] ffmpeg ${code}: ${errTail.slice(-200)}`); });
  } catch (e) {
    if (!res.headersSent) res.status(502).json({ error: "clip_failed", message: e.message });
  }
});

// ── Snapshot ISAPI (póster instantáneo del muro) ────────────────────────────
// El server pide la imagen al NVR con Digest y la sirve; caché corta en memoria
// para no machacar al NVR cuando hay muchas tiles.
const SNAP_CACHE = new Map(); // deviceId → { ts, buf }
const SNAP_TTL = 1500; // TTL del snapshot cacheado (ms). Sube = menos carga al NVR.
const SNAP_FAIL = new Map();      // id → ts del último fallo (backoff negativo)
const SNAP_FAIL_TTL = 4000;       // no re-pegar a un canal caído por este tiempo
const SNAP_INFLIGHT = new Map();  // id → Promise<Buffer> (dedup de capturas en curso)
// Semáforo por HOST: los canales de un NVR comparten IP; si el muro de evidencia
// dispara ~17 capturas a la vez el NVR se satura (504) y devuelve 503 en canales
// ocupados. Limitamos las capturas concurrentes por equipo.
const _snapHostSem = new Map();   // host → { active, queue: [] }
const SNAP_HOST_MAX = 3;
function snapHostAcquire(host) {
  let s = _snapHostSem.get(host);
  if (!s) { s = { active: 0, queue: [] }; _snapHostSem.set(host, s); }
  return new Promise((resolve) => {
    const go = () => { if (s.active < SNAP_HOST_MAX) { s.active++; resolve(); } else { s.queue.push(go); } };
    go();
  });
}
function snapHostRelease(host) {
  const s = _snapHostSem.get(host);
  if (!s) return;
  s.active = Math.max(0, s.active - 1);
  const n = s.queue.shift();
  if (n) n();
}

// Placeholder "SIN SEÑAL" (SVG): se sirve con 200 cuando un canal está caído y no
// hay último frame bueno, en vez de 502 → el visor muestra un estado limpio y no
// spamea errores ni imágenes rotas.
const NOSIGNAL_SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180">' +
  '<rect width="320" height="180" fill="#0b0f16"/>' +
  '<g fill="none" stroke="#3a4658" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<rect x="126" y="74" width="56" height="32" rx="6"/>' +
  '<path d="M182 84l16-7v26l-16-7z"/>' +
  '<line x1="116" y1="62" x2="206" y2="120"/></g>' +
  '<text x="160" y="140" fill="#5b6b82" font-family="system-ui,Segoe UI,sans-serif" font-size="13" font-weight="600" text-anchor="middle" letter-spacing="1.5">SIN SEÑAL</text></svg>'
);
function serveNoSignal(res) {
  res.set("Content-Type", "image/svg+xml"); res.set("Cache-Control", "no-store");
  res.status(200).end(NOSIGNAL_SVG);
}
router.get("/camera/:id/snapshot", async (req, res) => {
  const id = String(req.params.id || "");
  let devices = [];
  try { devices = listConfig("devices"); } catch { /* store */ }
  const dev = devices.find((d) => d.id === id);
  if (!dev) return res.status(404).end();
  const serve = (buf) => { res.set("Content-Type", "image/jpeg"); res.set("Cache-Control", "no-store"); res.end(buf); };
  const cached = SNAP_CACHE.get(id);
  if (cached && Date.now() - cached.ts < SNAP_TTL) return serve(cached.buf);
  // Backoff negativo: si falló recién, no re-pegamos al equipo; servimos el último
  // frame bueno (si hay) para no romper el visor con imágenes rotas ni spamear el NVR.
  const failTs = SNAP_FAIL.get(id);
  if (failTs && Date.now() - failTs < SNAP_FAIL_TTL) {
    if (cached) return serve(cached.buf);
    return serveNoSignal(res);
  }
  // Dedup: si ya hay una captura en curso para este equipo, esperamos ESA.
  if (SNAP_INFLIGHT.has(id)) {
    const buf = await SNAP_INFLIGHT.get(id).catch(() => null);
    if (buf) return serve(buf);
    const c2 = SNAP_CACHE.get(id); if (c2) return serve(c2.buf);
    return serveNoSignal(res);
  }
  const fetchOne = (async () => {
    // Equipos SIN ISAPI (Tiandy/ONVIF/Dahua): snapshot desde el frame de go2rtc.
    if (rtspTemplateFor(dev.vendor)) {
      const buf = await fetchGo2rtcFrame(dev);
      if (!buf) throw new Error("go2rtc_frame");
      SNAP_CACHE.set(id, { ts: Date.now(), buf }); SNAP_FAIL.delete(id);
      return buf;
    }
    if (!dev.ip || !dev.isapiPort || !dev.username) throw Object.assign(new Error("sin_isapi"), { code: 404 });
    const ch = Number(dev.channel) > 0 ? Number(dev.channel) : 1;
    const host = dev.ip;
    await snapHostAcquire(host);
    try {
      const r = await digestGetBuffer({
        host, port: Number(dev.isapiPort), https: !!dev.isapiHttps,
        path: `/ISAPI/Streaming/channels/${ch}01/picture`,
        user: dev.username, pass: dev.password || "", timeoutMs: 8000,
      });
      if (r.status !== 200 || !r.buffer || r.buffer.length < 200 || !/image/i.test(r.contentType || "")) {
        throw Object.assign(new Error(`snap_${r.status}`), { code: r.status === 503 ? 503 : 502 });
      }
      SNAP_CACHE.set(id, { ts: Date.now(), buf: r.buffer }); SNAP_FAIL.delete(id);
      return r.buffer;
    } finally { snapHostRelease(host); }
  })();
  SNAP_INFLIGHT.set(id, fetchOne);
  try {
    serve(await fetchOne);
  } catch (e) {
    if (e && e.code === 404) return res.status(404).end();
    SNAP_FAIL.set(id, Date.now());
    const c3 = SNAP_CACHE.get(id);
    if (c3) return serve(c3.buf); // último frame bueno: mejor stale que roto
    serveNoSignal(res); // canal caído sin frame → placeholder limpio, no 502
    void e;
  } finally {
    SNAP_INFLIGHT.delete(id);
  }
});

// ── Vivo MJPEG (multipart de snapshots ISAPI) ───────────────────────────────
// El H264 RTSP de estas cámaras/NVR llega corrupto (~50% de frames con errores de
// decode → "puré gris"), pero el snapshot JPEG ISAPI es PERFECTO. Servimos un
// stream MJPEG (multipart/x-mixed-replace) sondeando snapshots: imagen nítida, sin
// corrupción, que el navegador pinta nativamente en un <img>. Vivo PRIMARIO fiable.
//
// Cada snapshot del NVR tarda ~0.5s, pero el NVR aguanta varias peticiones EN
// PARALELO → un "pump" por cámara mantiene CONCURRENCY fetches en vuelo y publica
// el frame más nuevo. Los espectadores comparten el pump (1 pump por cámara sin
// importar cuántos miran) → ~10-15 fps sin multiplicar la carga.
// Concurrencia del pump: de la config de video (Configuración › Video), con
// fallback al env y a 6. Se lee al arrancar cada pump.
function pumpConcurrency() {
  try { const n = Number(getVideo().mjpegConcurrency); if (n > 0) return Math.min(16, n); } catch { /* store */ }
  return Math.max(1, Number(process.env.EVENTOS_MJPEG_CONCURRENCY) || 6);
}
const MJPEG_MAX = 8;           // espectadores MJPEG concurrentes (cap global)
let mjpegViewers = 0;
const pumps = new Map();        // id → { latest, seq, viewers, running, dev }

function snapPump(id, dev, quality) {
  let p = pumps.get(id);
  if (!p) { p = { latest: null, seq: 0, viewers: 0, running: false, dev }; pumps.set(id, p); }
  p.dev = dev;
  if (quality === "main" || quality === "sub") p.quality = quality; // calidad pedida
  return p;
}
async function runPump(id) {
  const p = pumps.get(id);
  if (!p || p.running) return;
  p.running = true;
  const ch = Number(p.dev.channel) > 0 ? Number(p.dev.channel) : 1;
  const concurrency = pumpConcurrency();
  const grab = async () => {
    // Lee la calidad del pump en cada toma → cambiar main/sub se aplica sin reiniciar.
    let vq = p.quality; if (vq !== "main" && vq !== "sub") { try { vq = getVideo().quality; } catch { vq = "sub"; } }
    const suffix = vq === "main" ? "01" : "02"; // sub (…02) más rápido; main (…01) HD
    try {
      const r = await digestGetBuffer({
        host: p.dev.ip, port: Number(p.dev.isapiPort), https: !!p.dev.isapiHttps,
        path: `/ISAPI/Streaming/channels/${ch}${suffix}/picture`,
        user: p.dev.username, pass: p.dev.password || "", timeoutMs: 5000,
      });
      if (r.status === 200 && r.buffer && r.buffer.length > 200 && /image/i.test(r.contentType)) {
        p.latest = r.buffer; p.seq++; SNAP_CACHE.set(id, { ts: Date.now(), buf: r.buffer });
      }
    } catch { /* salta */ }
  };
  // CONCURRENCY trabajadores en bucle mientras haya espectadores.
  const workers = [];
  for (let i = 0; i < concurrency; i++) workers.push((async () => { while (p.viewers > 0) await grab(); })());
  await Promise.all(workers);
  p.running = false;
  if (p.viewers <= 0) pumps.delete(id);
}
router.get("/camera/:id/mjpeg", async (req, res) => {
  const id = String(req.params.id || "");
  let devices = [];
  try { devices = listConfig("devices"); } catch { /* store */ }
  const dev = devices.find((d) => d.id === id);
  if (!dev || !dev.ip || !dev.isapiPort || !dev.username) return res.status(404).end();
  if (mjpegViewers >= MJPEG_MAX) return res.status(503).end();
  mjpegViewers++;
  const q = req.query.q === "main" ? "main" : (req.query.q === "sub" ? "sub" : undefined);
  const p = snapPump(id, dev, q);
  p.viewers++;
  if (!p.running) runPump(id);
  const boundary = "eventosmjpeg";
  res.writeHead(200, {
    "Content-Type": `multipart/x-mixed-replace; boundary=${boundary}`,
    "Cache-Control": "no-store, no-cache, must-revalidate",
    Pragma: "no-cache", Connection: "close",
  });
  let alive = true;
  const stop = () => { alive = false; };
  req.on("close", stop); req.on("aborted", stop); res.on("error", stop);
  let lastSeq = -1;
  try {
    while (alive && !res.writableEnded) {
      if (p.latest && p.seq !== lastSeq) {
        lastSeq = p.seq;
        res.write(`--${boundary}\r\nContent-Type: image/jpeg\r\nContent-Length: ${p.latest.length}\r\n\r\n`);
        res.write(p.latest); res.write("\r\n");
      }
      await new Promise((r) => setTimeout(r, 30)); // sondea a ~33 Hz; emite al ritmo real del pump
    }
  } finally {
    mjpegViewers = Math.max(0, mjpegViewers - 1);
    p.viewers = Math.max(0, p.viewers - 1);
    try { res.end(); } catch { /* ya cerrado */ }
  }
});

// Info de cámara para la ficha premium: estado, modelo, FW, uptime, resolución,
// FPS, bitrate (best-effort por ISAPI directo si es alcanzable) + último evento.
const xtagInfo = (xml, t) => { const m = new RegExp(`<${t}>([\\s\\S]*?)</${t}>`, "i").exec(xml || ""); return m ? m[1].trim() : null; };
router.get("/camera/:id/info", async (req, res) => {
  const id = String(req.params.id || "");
  let devices = [];
  try { devices = listConfig("devices"); } catch { /* store */ }
  const dev = devices.find((d) => d.id === id);
  if (!dev) return res.status(404).json({ error: "no_device" });
  const proxied = (dev.tags || []).some((t) => /^nvr:/i.test(t));
  const out = {
    id, name: dev.name, ip: dev.camIp || dev.ip || null, channel: dev.channel ?? null,
    vendor: dev.vendor || null, via: null,
    online: false, model: dev.vendor || null, firmware: null, uptime: null,
    resolution: null, fps: null, bitrate: null, codec: null, lastEvent: null,
  };
  // Último evento de esta cámara.
  try {
    const last = listEvents({ limit: 300 }).find((e) => e.source && e.source.deviceId === id);
    if (last) out.lastEvent = { ts: last.ts, type: last.type, priority: last.priority };
  } catch { /* store */ }
  // ISAPI directo (cámara con IP propia alcanzable). Las cámaras detrás de NVR cuyo
  // web da 401 simplemente no completan estos campos (degradación elegante).
  const host = dev.camIp || (proxied ? null : dev.ip);
  // Portero/intercom Akuvox: no habla ISAPI. Salud por su HTTP API (system/info).
  const isAkuvox = /akuvox|intercom/i.test(String(dev.vendor || "") + " " + String(dev.type || ""));
  if (isAkuvox && host && dev.username) {
    try {
      const h = await akuvoxHealth({ host, port: Number(dev.isapiPort) || 443, user: dev.username, pass: dev.password || "", https: dev.isapiHttps !== false });
      if (h && h.online) { out.online = true; out.via = "akuvox"; out.model = h.model || out.model; out.firmware = h.firmware; out.uptime = h.uptimeSec != null ? h.uptimeSec : null; out.akuvox = h; }
    } catch { /* degradado */ }
  }
  if (!out.online && host && dev.username) {
    const port = Number(dev.isapiPort) || 80;
    const get = async (path) => {
      try { const r = await digestGetBuffer({ host, port, https: !!dev.isapiHttps, path, user: dev.username, pass: dev.password || "", timeoutMs: 4000 }); return r.status === 200 ? r.buffer.toString("utf8") : null; } catch { return null; }
    };
    const di = await get("/ISAPI/System/deviceInfo");
    if (di) { out.online = true; out.via = "isapi"; out.model = xtagInfo(di, "model") || out.model; out.firmware = xtagInfo(di, "firmwareVersion"); }
    const st = await get("/ISAPI/System/status");
    if (st) { const up = Number(xtagInfo(st, "deviceUpTime")); if (Number.isFinite(up)) out.uptime = up; }
    const ch = Number(dev.channel) > 0 ? Number(dev.channel) : 1;
    const cfg = await get(`/ISAPI/Streaming/channels/${ch}01`);
    if (cfg) {
      const w = xtagInfo(cfg, "videoResolutionWidth"), h = xtagInfo(cfg, "videoResolutionHeight");
      if (w && h) out.resolution = `${w}×${h}`;
      const fr = Number(xtagInfo(cfg, "maxFrameRate")); if (Number.isFinite(fr) && fr > 0) out.fps = Math.round(fr / 100);
      out.bitrate = Number(xtagInfo(cfg, "vbrUpperCap") || xtagInfo(cfg, "constantBitRate")) || null;
      out.codec = xtagInfo(cfg, "videoCodecType");
    }
  }
  // Sin ISAPI (Tiandy/ONVIF/Dahua u otro): online si el puerto RTSP responde.
  // Salud limitada: solo confirmamos alcance por RTSP, sin métricas del equipo.
  if (!out.online) {
    const rhost = dev.camIp || dev.ip;
    const rport = Number(dev.rtspPort) || 554;
    if (rhost) { out.online = await tcpReachable(rhost, rport, 3000); if (out.online) out.via = "rtsp"; }
  }
  res.json(out);
});

// Registro (Logs) del dispositivo: fusiona los eventos de EventOS de ese equipo
// con el registro NATIVO (porteros Akuvox: aperturas doorlog + llamadas calllog).
// El doorlog del E16C es pesado (~5MB); se cachea por dispositivo 60s.
const _deviceLogCache = new Map();
router.get("/device/:id/logs", async (req, res) => {
  const id = String(req.params.id || "");
  const limit = Math.max(1, Math.min(Number(req.query.limit) || 80, 300));
  let devices = [];
  try { devices = listConfig("devices"); } catch { /* store */ }
  const dev = devices.find((d) => d.id === id);
  if (!dev) return res.status(404).json({ error: "no_device" });
  const out = { deviceName: dev.name, native: false, entries: [], error: null };
  try {
    const evs = listEvents({ limit: 500 }).filter((e) => e.source && e.source.deviceId === id).slice(0, limit);
    for (const e of evs) out.entries.push({ ts: e.ts, source: "eventos", kind: "event", title: e.title || e.type, type: e.type, status: e.status, priority: e.priority != null ? e.priority : null, detail: e.zone || (e.source && e.source.site) || "" });
  } catch { /* store */ }
  const isAkuvox = /akuvox|intercom/i.test(String(dev.vendor || "") + " " + String(dev.type || ""));
  if (isAkuvox && (dev.camIp || dev.ip) && dev.username) {
    try {
      const cached = _deviceLogCache.get(id);
      let nat;
      if (cached && Date.now() - cached.ts < 60000) nat = cached.entries;
      else { nat = await akuvoxLogs({ host: dev.camIp || dev.ip, port: Number(dev.isapiPort) || 443, user: dev.username, pass: dev.password || "", https: dev.isapiHttps !== false }, 150); _deviceLogCache.set(id, { ts: Date.now(), entries: nat }); }
      out.native = true;
      out.entries.push(...nat);
    } catch (e) { out.error = e.message; }
  }
  // Cualquier equipo Hik con ISAPI (cámara, NVR, central AX) trae su registro
  // nativo por logSearch. Antes exigíamos vendor~/hik/, dejando fuera cámaras y
  // alarmas sin ese campo; ahora lo intentamos para cámara/nvr/alarma con
  // credenciales (si no es Hik, el probe digest falla y devuelve [] sin ruido).
  const looksHik = /hik/i.test(String(dev.vendor || "") + " " + String(dev.model || ""));
  const hikCandidate = ["camera", "nvr", "dvr", "alarm"].includes(String(dev.type || "").toLowerCase());
  const isHik = !isAkuvox && (looksHik || hikCandidate);
  if (isHik && (dev.ip || dev.camIp) && dev.username) {
    try {
      const cached = _deviceLogCache.get(id);
      let nat;
      if (cached && Date.now() - cached.ts < 60000) nat = cached.entries;
      else {
        nat = await hikLogs({ host: dev.ip || dev.camIp, port: Number(dev.isapiPort) || 80, user: dev.username, pass: dev.password || "", https: !!dev.isapiHttps, all: true, channel: /nvr|dvr/i.test(String(dev.type || "")) ? null : (dev.channel ?? null) }, 250);
        _deviceLogCache.set(id, { ts: Date.now(), entries: nat });
      }
      out.native = true;
      out.entries.push(...nat);
    } catch (e) { out.error = e.message; }
  }
  out.entries.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
  out.entries = out.entries.slice(0, limit);
  res.json(out);
});

// Usuarios/accesos cargados en un portero Akuvox (tarjetas, PIN, rostros).
router.get("/device/:id/akuvox-users", async (req, res) => {
  const id = String(req.params.id || "");
  let devices = [];
  try { devices = listConfig("devices"); } catch { /* store */ }
  const dev = devices.find((d) => d.id === id);
  if (!dev) return res.status(404).json({ error: "no_device" });
  const isAkuvox = /akuvox|intercom/i.test(String(dev.vendor || "") + " " + String(dev.type || ""));
  if (!isAkuvox) return res.status(400).json({ error: "no_akuvox" });
  try {
    const opt = { host: dev.camIp || dev.ip, port: Number(dev.isapiPort) || 8082, secure: dev.isapiHttps !== false, user: dev.username, pass: dev.password || "" };
    const list = await akuvoxUsers(opt);
    res.json({ deviceName: dev.name, count: list.length, users: list });
  } catch (e) { res.status(502).json({ error: "akuvox_users", message: e.message }); }
});

// Proxy del rostro (FaceUrl) de un usuario del portero → la UI muestra la cara.
router.get("/device/:id/akuvox-face", async (req, res) => {
  const id = String(req.params.id || "");
  const url = String(req.query.url || "");
  if (!url) return res.status(400).end();
  let devices = [];
  try { devices = listConfig("devices"); } catch { /* store */ }
  const dev = devices.find((d) => d.id === id);
  if (!dev) return res.status(404).end();
  try {
    const opt = { host: dev.camIp || dev.ip, port: Number(dev.isapiPort) || 8082, secure: dev.isapiHttps !== false, user: dev.username, pass: dev.password || "" };
    const img = await akuvoxFace(opt, url);
    if (!img) return res.status(404).end();
    res.set("Content-Type", img.contentType); res.set("Cache-Control", "private, max-age=300");
    res.end(img.buffer);
  } catch { res.status(502).end(); }
});

// Helper: opciones de conexión Akuvox desde el dispositivo.
function akuvoxOpt(dev) {
  return { host: dev.camIp || dev.ip, port: Number(dev.isapiPort) || 8082, secure: dev.isapiHttps !== false, user: dev.username, pass: dev.password || "" };
}
function findAkuvox(id) {
  let devices = [];
  try { devices = listConfig("devices"); } catch { /* store */ }
  const dev = devices.find((d) => d.id === id);
  if (!dev) return { err: 404, code: "no_device" };
  const isAkuvox = /akuvox|intercom/i.test(String(dev.vendor || "") + " " + String(dev.type || ""));
  if (!isAkuvox) return { err: 400, code: "no_akuvox" };
  return { dev };
}

// Aprovisionamiento Akuvox: alta/edición de usuario (nombre, tarjeta, PIN, grupo).
// CONFIGURACIÓN iniciada por el operador — nunca abre puertas ni dispara relés.
router.post("/device/:id/akuvox-user", async (req, res) => {
  const { dev, err, code } = findAkuvox(String(req.params.id || ""));
  if (err) return res.status(err).json({ error: code });
  const b = req.body || {};
  if (!b.name && !b.userId) return res.status(400).json({ error: "name_required" });
  try {
    const mode = b.userId ? "set" : "add";
    const r = await akuvoxUserSave(akuvoxOpt(dev), { userId: b.userId, name: b.name, card: b.card, pin: b.pin, group: b.group, doorNum: b.doorNum, phone: b.phone }, mode);
    if (!r.ok) return res.status(502).json({ error: "akuvox_write", retcode: r.retcode, message: r.message || `retcode ${r.retcode}` });
    res.json({ ok: true, mode });
  } catch (e) { res.status(502).json({ error: "akuvox_write", message: e.message }); }
});

// Baja de usuario del portero.
router.delete("/device/:id/akuvox-user/:userId", async (req, res) => {
  const { dev, err, code } = findAkuvox(String(req.params.id || ""));
  if (err) return res.status(err).json({ error: code });
  try {
    const r = await akuvoxUserDel(akuvoxOpt(dev), String(req.params.userId || ""));
    if (!r.ok) return res.status(502).json({ error: "akuvox_del", retcode: r.retcode, message: r.message || `retcode ${r.retcode}` });
    res.json({ ok: true });
  } catch (e) { res.status(502).json({ error: "akuvox_del", message: e.message }); }
});

// Diagnóstico (read-only): volcado crudo de user/get + endpoints candidatos de
// rostro, para descubrir dónde vive el FaceUrl en este firmware.
router.get("/device/:id/akuvox-raw", async (req, res) => {
  const { dev, err, code } = findAkuvox(String(req.params.id || ""));
  if (err) return res.status(err).json({ error: code });
  try { res.json(await akuvoxRawDump(akuvoxOpt(dev))); }
  catch (e) { res.status(502).json({ error: "akuvox_raw", message: e.message }); }
});

// Ajustes de video (público, solo lectura): el visor en vivo lee el modo/calidad.
router.get("/video-settings", (req, res) => {
  try { res.json(getVideo()); } catch { res.json({ liveMode: "mjpeg", quality: "sub" }); }
});

// Salud y meta
router.get("/health", (req, res) => {
  const { counts } = queueState();
  let dispatch = { mode: "unknown" };
  let devices = 0;
  let rules = 0;
  try {
    dispatch = { mode: getDispatch().mode };
    devices = listConfig("devices").length;
    rules = listConfig("rules").length;
  } catch {
    /* el store podría no estar disponible; no romper health */
  }
  res.json({
    ok: true,
    uptime: Math.floor((Date.now() - startedAt) / 1000),
    redis: bus.mode(),
    operators: listOperators().length,
    queue: counts,
    dispatch,
    devices,
    rules,
  });
});

// Eventos (más recientes primero)
router.get("/events", (req, res) => {
  const status = req.query.status || undefined;
  const limit = Math.max(1, Math.min(Number(req.query.limit) || 50, 500));
  res.json({ events: listEvents({ status, limit }) });
});

// Historial PAGINADO desde Postgres (keyset por ts). A diferencia de /events (cola en
// vivo en memoria, acotada), sirve el histórico COMPLETO sin cargarlo en RAM: filtros
// status/site/deviceId y cursor `before` (ISO). Si PG no está, devuelve { events: [] }.
router.get("/events/history", async (req, res) => {
  try {
    const out = await listHistory({
      limit: req.query.limit,
      before: req.query.before || null,
      status: req.query.status || null,
      site: req.query.site || null,
      deviceId: req.query.deviceId || null,
    });
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: "history_failed", message: e.message });
  }
});

router.get("/events/:id", (req, res) => {
  const event = getEvent(req.params.id);
  if (!event) return res.status(404).json({ error: "not_found" });
  res.json({ event });
});

// Operarios
router.get("/operators", (req, res) => {
  res.json({ operators: listOperators() });
});

// Cámaras (solo lectura, sin secretos) — alimenta el muro de verificación del popup.
// Filtra por ?site= (nombre de sitio o siteId). Devuelve metadatos + URLs de video/snapshot.
router.get("/cameras", (req, res) => {
  let devices = [];
  let sites = [];
  try {
    devices = listConfig("devices");
    sites = listConfig("sites");
  } catch {
    /* store no disponible */
  }
  const siteName = (id) => {
    const s = sites.find((x) => x.id === id);
    return s ? s.name : null;
  };
  const q = (req.query.site || "").toString().trim().toLowerCase();
  const cameras = devices
    .filter((d) => d.enabled !== false)
    .map((d) => ({
      id: d.id,
      name: d.name,
      type: d.type,
      vendor: d.vendor || null,
      channel: d.channel ?? null,
      ip: d.ip || null,
      zone: d.zone || null,
      area: d.area || null, // 'interior' | 'perimeter' — etiqueta de ubicación para el muro
      siteId: d.siteId || null,
      site: siteName(d.siteId),
      online: deviceOnline(d.id), // true/false/null — reachability cacheada (status sampler)
      streamUrl: d.streamUrl || null, // HLS/WebRTC/MJPEG (gateway) — opcional
      snapshotUrl: d.snapshotUrl || null, // imagen fija refrescable — opcional
      wallLinks: Array.isArray(d.wallLinks) ? d.wallLinks : [], // hotspots de seguimiento (visual tracking)
    }))
    .filter(
      (d) =>
        !q ||
        (d.site && d.site.toLowerCase() === q) ||
        (d.siteId && d.siteId.toLowerCase() === q)
    );
  res.json({ cameras });
});

// ── Analíticas configuradas en la cámara (ISAPI Smart) ──────────────────────
// Reglas DIBUJADAS sobre la imagen (líneas de cruce, zonas de intrusión/entrada/
// salida) en coordenadas normalizadas 0–1000 para overlay. Hikvision usa origen
// abajo-izquierda (Y hacia arriba) → el cliente invierte Y.
function parseLineRules(xml) {
  const out = [];
  for (const it of xml.split(/<LineItem>/).slice(1)) {
    // Dibujamos toda línea con geometría real (2 puntos distintos), igual que las
    // zonas: no filtramos por <enabled> del item — algunos firmwares reportan la
    // línea dibujada como enabled=false aunque la detección de cruce esté activa.
    // Los slots sin usar quedan fuera por el filtro de puntos distintos de abajo.
    const id = (it.match(/<id>(\d+)<\/id>/) || [])[1] || null;
    const dir = (it.match(/<directionSensitivity>([^<]+)/) || [])[1] || "any";
    const pts = [...it.matchAll(/<positionX>(\d+)<\/positionX>\s*<positionY>(\d+)<\/positionY>/g)]
      .map((m) => ({ x: +m[1], y: +m[2] }));
    const uniq = new Set(pts.map((p) => `${p.x},${p.y}`));
    if (pts.length >= 2 && uniq.size >= 2) out.push({ type: "line", id, direction: dir, points: pts.slice(0, 2) });
  }
  return out;
}
function parseRegionRules(xml, type) {
  const out = [];
  // Bloques de región (FieldDetectionRegion / RegionEntranceRegion / RegionExitingRegion / Region).
  for (const m of xml.matchAll(/<(\w*Region)\b[^>]*>([\s\S]*?)<\/\1>/g)) {
    const body = m[2];
    const cl = /<RegionCoordinatesList>([\s\S]*?)<\/RegionCoordinatesList>/i.exec(body);
    if (!cl) continue;
    const pts = [...cl[1].matchAll(/<positionX>(\d+)<\/positionX>\s*<positionY>(\d+)<\/positionY>/g)]
      .map((c) => ({ x: +c[1], y: +c[2] }));
    if (pts.length >= 3) {
      const id = (body.match(/<id>(\d+)<\/id>/) || [])[1] || null;
      out.push({ type, id, points: pts });
    }
  }
  return out;
}
const ANALYTICS_TYPES = [
  ["LineDetection", "line"], ["FieldDetection", "field"],
  ["regionEntrance", "entrance"], ["regionExiting", "exiting"],
  ["unattendedBaggage", "baggage"], ["attendedBaggage", "takenaway"],
];
const ANALYTICS_CACHE = new Map(); // deviceId → { ts, data }
// ¿La cámara-canal está detrás de un NVR? (comparte IP con un dispositivo type=nvr).
// En un NVR Hik el recurso Smart por canal usa el id canal*100+1 (101, 301…),
// mientras que una cámara IP directa lo expone en el canal simple. Probamos el
// formato correcto primero según el caso, con el otro como respaldo.
function analyticsChannelIds(dev, devices) {
  const ch = Number(dev.channel) > 0 ? Number(dev.channel) : 1;
  const behindNvr = (devices || []).some((n) => n.type === "nvr" && n.id !== dev.id && n.ip && n.ip === dev.ip);
  const ids = behindNvr ? [ch * 100 + 1, ch] : [ch, ch * 100 + 1];
  return [...new Set(ids)];
}
// Trae las reglas dibujadas (líneas/zonas) para un id de canal ISAPI concreto.
// `ok` indica si el canal respondió 200 (aunque no tenga reglas) → canal válido.
async function fetchAnalyticsForChannel(dev, host, port, chId) {
  const rules = [];
  let ok = false;
  for (const [pathName, kind] of ANALYTICS_TYPES) {
    try {
      const r = await digestGetBuffer({
        host, port, https: !!dev.isapiHttps,
        path: `/ISAPI/Smart/${pathName}/${chId}`, user: dev.username, pass: dev.password || "", timeoutMs: 6000,
      });
      if (r.status === 200) {
        ok = true;
        const xml = r.buffer.toString("utf8");
        if (kind === "line") rules.push(...parseLineRules(xml));
        else rules.push(...parseRegionRules(xml, kind));
      }
    } catch { /* sigue con el resto */ }
  }
  return { ok, rules };
}
async function getDeviceAnalytics(dev, fresh = false) {
  if (!dev || !dev.ip || !dev.isapiPort || !dev.username) return null;
  const cached = ANALYTICS_CACHE.get(dev.id);
  // fresh=true → ignora la caché y re-lee del equipo (sync manual): si la cámara
  // cambió/borró una analítica, se refleja al instante.
  if (!fresh && cached && Date.now() - cached.ts < 30000) return cached.data;
  let devices = [];
  try { devices = listConfig("devices"); } catch { /* store */ }
  const ch = Number(dev.channel) > 0 ? Number(dev.channel) : 1;
  const host = dev.ip, port = Number(dev.isapiPort);
  let rules = [];
  // Prueba el/los id(s) de canal; se queda con el primero que traiga reglas, o
  // con el primero que responda 200 (canal válido aunque no tenga analíticas).
  for (const chId of analyticsChannelIds(dev, devices)) {
    const r = await fetchAnalyticsForChannel(dev, host, port, chId);
    if (r.rules.length) { rules = r.rules; break; }
    if (r.ok) { rules = r.rules; break; }
  }
  const data = { channel: ch, space: 1000, rules };
  ANALYTICS_CACHE.set(dev.id, { ts: Date.now(), data });
  return data;
}
router.get("/camera/:id/analytics", async (req, res) => {
  let devices = [];
  try { devices = listConfig("devices"); } catch { /* store */ }
  const dev = devices.find((d) => d.id === String(req.params.id || ""));
  const fresh = req.query.fresh === "1" || req.query.fresh === "true";
  const data = await getDeviceAnalytics(dev, fresh);
  if (!data) return res.status(404).json({ error: "no_device" });
  res.json(data);
});

// Bulk: dado un set de deviceIds, devuelve cuántas reglas dibujadas tiene cada uno
// (para marcar en la rejilla qué cámaras tienen analíticas). Concurrencia limitada.
router.post("/cameras/analytics-flags", async (req, res) => {
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.slice(0, 120).map(String) : [];
  let devices = [];
  try { devices = listConfig("devices"); } catch { /* store */ }
  const byId = new Map(devices.map((d) => [d.id, d]));
  const flags = {};
  const queue = ids.slice();
  let active = 0;
  await new Promise((resolve) => {
    const next = () => {
      if (!queue.length && active === 0) return resolve();
      while (active < 4 && queue.length) {
        const id = queue.shift(); active++;
        getDeviceAnalytics(byId.get(id))
          .then((d) => { flags[id] = d ? d.rules.length : 0; })
          .catch(() => { flags[id] = 0; })
          .finally(() => { active--; next(); });
      }
    };
    next();
  });
  res.json({ flags });
});

// Cliente / contactos (CONTRACT-V3 §2) — público (sin token admin).
// Alimenta el panel "Cliente / Contactos" del popup. Resuelve el sitio por
// nombre o por siteId. Contactos ordenados por `order` asc.
router.get("/client", (req, res) => {
  let sites = [];
  try {
    sites = listConfig("sites");
  } catch {
    /* store no disponible */
  }
  const q = (req.query.site || "").toString().trim();
  const ql = q.toLowerCase();
  const site =
    sites.find((s) => s.id === q) ||
    sites.find((s) => (s.name || "").toLowerCase() === ql) ||
    null;

  if (!site) {
    // Tolerante: sin sitio, devolvemos estructura vacía (no 404 para no romper el popup).
    return res.json({ site: null, contacts: [] });
  }

  const contacts = Array.isArray(site.contacts) ? [...site.contacts] : [];
  contacts.sort((a, b) => (Number(a?.order ?? 0) - Number(b?.order ?? 0)));

  // Parlantes / intercomunicadores SIP del cliente (CONTRACT-V3): cada uno con
  // nombre/zona y un destino de marcado (uri SIP o teléfono). El operador los
  // llama desde el popup con un toque (sip:/tel:).
  const speakers = Array.isArray(site.speakers) ? [...site.speakers] : [];
  speakers.sort((a, b) => (Number(a?.order ?? 0) - Number(b?.order ?? 0)));

  res.json({
    site: {
      name: site.name || null,
      address: site.address || null,
      account: site.account || null,
      protocol: site.protocol || null,
      emergencyNumber: site.emergencyNumber || null,
      lat: Number.isFinite(Number(site.lat)) ? Number(site.lat) : null,
      lng: Number.isFinite(Number(site.lng)) ? Number(site.lng) : null,
    },
    contacts: contacts.map((c) => ({
      name: c?.name || null,
      role: c?.role || null,
      phone: c?.phone || null,
      order: Number(c?.order ?? 0),
    })),
    speakers: speakers.map((s) => ({
      name: s?.name || null,
      zone: s?.zone || null,
      sip: s?.sip || null,
      phone: s?.phone || null,
      order: Number(s?.order ?? 0),
    })),
  });
});

// Procedimiento por id (solo lectura, público) — el operador ve los pasos REALES
// configurados en Admin, no el fallback embebido. Tolerante: 404 si no existe.
router.get("/procedures/:id", (req, res) => {
  let proc = null;
  try { proc = getProcedure(req.params.id); } catch { /* store no disponible */ }
  if (!proc) return res.status(404).json({ error: "not_found" });
  res.json(proc);
});

// Sitios (solo lectura, público) — para el MAPA OPERATIVO de la consola.
// Devuelve nombre, cuenta, dirección y coordenadas (si las tiene).
router.get("/sites", (req, res) => {
  let sites = [];
  try { sites = listConfig("sites"); } catch { /* store no disponible */ }
  res.json({
    sites: sites.map((s) => ({
      id: s.id,
      name: s.name || null,
      clientGroupId: s.clientGroupId || null,
      account: s.account || null,
      address: s.address || null,
      lat: Number.isFinite(Number(s.lat)) ? Number(s.lat) : null,
      lng: Number.isFinite(Number(s.lng)) ? Number(s.lng) : null,
    })),
  });
});

// Grupos de clientes (solo lectura, publico) — clasifican sitios para filtrar en consola.
router.get("/clientGroups", (req, res) => {
  let groups = [];
  try { groups = listConfig("clientGroups"); } catch { /* store */ }
  res.json({ clientGroups: groups.map((g) => ({ id: g.id, name: g.name || null, color: g.color || null })) });
});

// Roster de operarios (solo lectura, público) — el LISTADO configurado en Admin
// (no los runtime conectados), para el login con avatares de la consola.
router.get("/roster", (req, res) => {
  let ops = [];
  try { ops = listConfig("operators"); } catch { /* store no disponible */ }
  res.json({
    operators: ops
      .filter((o) => o.active !== false)
      .map((o) => ({
        id: o.id, name: o.name || "Operario",
        skills: Array.isArray(o.skills) ? o.skills : [],
        role: opRole(o),
        hasPin: !!o.pinHash, // el cliente pide PIN solo si lo tiene configurado
      })),
  });
});

// Login con USUARIO + CONTRASEÑA. Verifica la contraseña (scrypt) contra el
// hash del operario, emite la sesión (cookie HttpOnly) que autoriza TODA la
// consola, video, acciones físicas y socket, y devuelve perfil + rol. El rol
// define el panel: agente → consola; supervisor → +videowall/supervisor;
// admin → +administración. Sin passwordHash configurado NO se puede entrar
// (una instancia pública no acepta operarios sin credencial).
router.post("/auth/login", (req, res) => {
  const body = req.body || {};
  const username = String(body.username || "").trim().toLowerCase();
  const password = body.password == null ? "" : String(body.password);
  if (!username || !password) return res.status(400).json({ ok: false, error: "missing_credentials" });
  // Rate limit anti fuerza-bruta: por IP (20/5min) y por IP+usuario (8/5min).
  const ip = clientIp(req);
  if (!rateHit(`login:ip:${ip}`, 20) || !rateHit(`login:${ip}:${username}`, 8)) {
    return res.status(429).json({ ok: false, error: "too_many_attempts", message: "demasiados intentos, esperá unos minutos" });
  }
  let ops = [];
  try { ops = listConfig("operators"); } catch { /* store */ }
  const op = ops.find((o) => (o.username || "").toLowerCase() === username && o.active !== false);
  // Respuesta uniforme (no revela si el usuario existe) y verificación constante.
  if (!op || !op.passwordHash || !verifyPin(password, op.passwordHash)) {
    return res.status(401).json({ ok: false, error: "bad_credentials" });
  }
  rateReset(`login:${ip}:${username}`); // login OK → limpiar el contador de ese usuario
  const role = opRole(op);
  const sid = createSession({ operatorId: op.id, name: op.name || "Operario", role });
  res.cookie(SESSION_COOKIE, sid, cookieOptions(req));
  res.json({
    ok: true,
    operator: { operatorId: op.id, name: op.name || "Operario", username: op.username, skills: Array.isArray(op.skills) ? op.skills : [], role, avatarUrl: op.avatarUrl || null },
    adminToken: role === "admin" ? (config.adminToken || null) : null,
  });
});

// Sesión actual (para rehidratar el login al recargar). 401 si no hay sesión.
router.get("/auth/me", (req, res) => {
  const s = sessionFromReq(req);
  if (!s) return res.status(401).json({ ok: false, error: "no_session" });
  let op = null; try { op = (listConfig("operators") || []).find((o) => o.id === s.operatorId); } catch { /* store */ }
  res.json({ ok: true, operator: { operatorId: s.operatorId, name: s.name, role: s.role, avatarUrl: (op && op.avatarUrl) || null } });
});

// Cierre de sesión: destruye la sesión y limpia la cookie.
router.post("/auth/logout", (req, res) => {
  // Recuperamos el token crudo de la cookie para destruir la sesión puntual.
  const raw = req.headers && req.headers.cookie;
  if (raw) {
    for (const part of raw.split(";")) {
      const i = part.indexOf("=");
      if (i !== -1 && part.slice(0, i).trim() === SESSION_COOKIE) {
        destroySession(decodeURIComponent(part.slice(i + 1).trim()));
      }
    }
  }
  res.clearCookie(SESSION_COOKIE, { path: "/" });
  res.json({ ok: true });
});

// ── Perfil del operario: cambiar clave + avatar ──────────────────────────────
// Cambiar la propia contraseña (operario logueado). Verifica la actual.
router.post("/auth/change-password", (req, res) => {
  const s = sessionFromReq(req);
  if (!s) return res.status(401).json({ ok: false, error: "no_session" });
  const { current, next } = req.body || {};
  if (!next || String(next).length < 4) return res.status(400).json({ ok: false, error: "weak_password" });
  let ops = []; try { ops = listConfig("operators"); } catch { /* store */ }
  const op = ops.find((o) => o.id === s.operatorId);
  if (!op) return res.status(404).json({ ok: false, error: "not_found" });
  if (op.passwordHash && !verifyPin(current, op.passwordHash)) return res.status(403).json({ ok: false, error: "bad_current" });
  updateConfig("operators", op.id, { passwordHash: hashPin(String(next)) });
  res.json({ ok: true });
});

// Subir/actualizar el avatar propio (dataURL base64 <= 2MB). Guarda en data/avatars.
router.post("/auth/avatar", (req, res) => {
  const s = sessionFromReq(req);
  if (!s) return res.status(401).json({ ok: false, error: "no_session" });
  const dataUrl = (req.body && req.body.dataUrl) || "";
  const m = /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl));
  if (!m) return res.status(400).json({ ok: false, error: "bad_image" });
  const buf = Buffer.from(m[2], "base64");
  if (buf.length > 2 * 1024 * 1024) return res.status(413).json({ ok: false, error: "too_big" });
  const ext = m[1].startsWith("jp") ? "jpg" : m[1];
  try {
    fs.mkdirSync(AVATAR_DIR, { recursive: true });
    const file = `${s.operatorId}.${ext}`;
    fs.writeFileSync(path.join(AVATAR_DIR, file), buf);
    const avatarUrl = `/api/avatars/${file}?v=${Date.now()}`;
    updateConfig("operators", s.operatorId, { avatarUrl });
    res.json({ ok: true, avatarUrl });
  } catch (e) {
    res.status(500).json({ ok: false, error: "save_failed", message: e.message });
  }
});

// Servir avatares (público, como la evidencia).
router.get("/avatars/:file", (req, res) => {
  const name = path.basename(String(req.params.file || ""));
  const fp = path.join(AVATAR_DIR, name);
  if (!fp.startsWith(AVATAR_DIR) || !fs.existsSync(fp)) return res.status(404).end();
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.sendFile(fp);
});

// ── App de escritorio (Windows/Electron): descarga del instalador ────────────
// Publicar una versión nueva = dejar el .exe en server/data/desktop/. El endpoint
// toma automáticamente el .exe más reciente; el número de versión sale del nombre.
function desktopInstaller() {
  try {
    if (!fs.existsSync(DESKTOP_DIR)) return null;
    const exes = fs.readdirSync(DESKTOP_DIR).filter((f) => f.toLowerCase().endsWith(".exe"));
    if (!exes.length) return null;
    const withStat = exes.map((f) => ({ f, st: fs.statSync(path.join(DESKTOP_DIR, f)) }));
    withStat.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs); // más reciente primero
    const top = withStat[0];
    const m = top.f.match(/(\d+\.\d+\.\d+)/);
    return { file: top.f, sizeBytes: top.st.size, builtAt: top.st.mtime.toISOString(), version: m ? m[1] : null };
  } catch { return null; }
}

// Metadatos del último instalador (para pintar el botón en la web).
router.get("/desktop/latest", (req, res) => {
  const info = desktopInstaller();
  if (!info) return res.json({ available: false });
  res.json({ available: true, version: info.version, filename: info.file, sizeBytes: info.sizeBytes, builtAt: info.builtAt, url: "/api/desktop/download" });
});

// Descarga del instalador (público, como evidencia/avatares).
router.get("/desktop/download", (req, res) => {
  const info = desktopInstaller();
  if (!info) return res.status(404).json({ error: "installer_not_available" });
  const fp = path.join(DESKTOP_DIR, info.file);
  if (!fp.startsWith(DESKTOP_DIR) || !fs.existsSync(fp)) return res.status(404).end();
  const safe = info.file.replace(/[^\w .()-]/g, "_");
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename="${safe}"`);
  res.setHeader("Content-Length", String(info.sizeBytes));
  res.sendFile(fp);
});

// Grupos (solo lectura, público) — para el selector "Transferir a grupo" del popup.
router.get("/groups", (req, res) => {
  let groups = [];
  try { groups = listConfig("groups"); } catch { /* store no disponible */ }
  res.json({
    groups: groups.map((g) => ({
      id: g.id,
      name: g.name || "Grupo",
      memberCount: Array.isArray(g.operatorIds) ? g.operatorIds.length : 0,
    })),
  });
});

export default router;
