// api.js — /api/health, /api/events, /api/events/:id, /api/operators (CONTRACT §3)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Router } from "express";
import { bus } from "../bus/redisBus.js";
import { listEvents, getEvent, listOperators, queueState } from "../dispatch/store.js";
import { getDispatch, list as listConfig, getProcedure, getVideo } from "../config/store.js";
import { startHls, startHlsFromStream, sessionFile, stopHls, keepAlive } from "../playback/hls.js";
import { searchSegment, openDownload, compactToMs } from "../playback/contentmgmt.js";
import { digestGetBuffer, digestRequest } from "../util/digestFetch.js";
import { verifyPin } from "../auth/pin.js";
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

// Relé / salida física (abrir puerta). ACCIÓN FÍSICA: la UI confirma con el
// operador antes de llamar. Hikvision IO output por defecto; AX configurable.
router.post("/device/:id/relay", async (req, res) => {
  const id = String(req.params.id || "");
  let devices = []; try { devices = listConfig("devices"); } catch {}
  const dev = devices.find((d) => d.id === id);
  if (!dev) return res.status(404).json({ error: "no_device" });
  const host = dev.ip || dev.camIp;
  const port = Number(dev.isapiPort) || 80;
  if (!host || !dev.username) return res.status(400).json({ error: "no_creds", message: "El dispositivo no tiene IP/usuario." });
  const output = String((req.body && req.body.output) != null ? req.body.output : 1);
  if (!/^[0-9-]+$/.test(output)) return res.status(400).json({ error: "bad_output" });
  const kind = (req.body && req.body.kind) || dev.relayKind || "hik-io";
  let path, body, contentType;
  if (kind === "ax") {
    path = `/ISAPI/SecurityCP/control/outputs/${output}?format=json`;
    body = JSON.stringify({ OutputsCtrl: { switch: "open" } });
    contentType = "application/json";
  } else {
    path = `/ISAPI/System/IO/outputs/${output}/trigger`;
    body = `<IOPortData><outputState>high</outputState></IOPortData>`;
    contentType = "application/xml";
  }
  try {
    const r = await digestRequest({ host, port, path, method: "PUT", body, contentType, user: dev.username, pass: dev.password || "", timeoutMs: 6000 });
    const ok = r.status >= 200 && r.status < 300;
    res.json({ ok, status: r.status, message: r.text ? String(r.text).slice(0, 300) : "" });
  } catch (e) {
    res.status(502).json({ error: "relay_failed", message: e.message });
  }
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
function deviceLiveRtsp(dev, quality) {
  const suffix = quality === "main" ? "01" : "02";
  const ch = Number(dev.channel) > 0 ? Number(dev.channel) : 1;
  if (dev.username && dev.rtspPort && dev.ip) {
    const u = encodeURIComponent(dev.username);
    const p = encodeURIComponent(dev.password || "");
    return `rtsp://${u}:${p}@${dev.ip}:${dev.rtspPort}/Streaming/channels/${ch}${suffix}`;
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
  const port = dev.camIp ? 554 : (Number(dev.rtspPort) || 554);
  const suffix = quality === "main" ? "01" : "02";
  const u = encodeURIComponent(dev.username);
  const p = encodeURIComponent(dev.password || "");
  return `rtsp://${u}:${p}@${host}:${port}/Streaming/Channels/1${suffix}`; // cámara = 1 canal
}
// Vivo DIRECTO por go2rtc (MSE), sin transcode (stream limpio). 404 si no hay
// camIp → el front cae al MJPEG por el NVR.
router.post("/live-direct", async (req, res) => {
  const body = req.body || {};
  const deviceId = String(body.deviceId || "");
  const quality = body.quality === "main" ? "main" : "sub";
  let devices = [];
  try { devices = listConfig("devices"); } catch { /* store */ }
  const dev = devices.find((d) => d.id === deviceId);
  if (!dev) return res.status(404).json({ error: "no_device" });
  const rtsp = deviceDirectRtsp(dev, quality);
  if (!rtsp) return res.status(404).json({ error: "no_direct" });
  try {
    // El nombre incluye la CALIDAD → main y sub son streams separados (permite
    // alternar en vivo sin pisar uno con otro).
    // Transcodificar (re-encode) en vez de copy: las cámaras H.264+/SmartCodec
    // de cesimco emiten un SPS que el navegador rechaza por MSE ([VideoRTC] Video
    // error). ffmpeg reescribe un SPS válido → vivo limpio. (copy fallaba en ellas.)
    const name = await registerGo2rtc(`cam_${deviceId}_${quality}`, go2rtcTranscodeSrc(rtsp));
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
function go2rtcTranscodeSrc(rtsp) {
  // #video=h264 (libx264) reescribe el SPS; #audio=aac para que MSE pueda mux.
  return `ffmpeg:${rtsp}#video=h264#audio=aac`;
}
async function registerGo2rtc(name, src) {
  const r = await fetch(`http://127.0.0.1:1984/api/streams?name=${encodeURIComponent(name)}&src=${encodeURIComponent(src)}`, { method: "PUT" });
  if (!r.ok) throw new Error(`go2rtc ${r.status}`);
  return name;
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
  const dev = devices.find((d) => d.id === deviceId);
  if (!dev) return res.status(404).json({ error: "no_device" });
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
  const dev = devices.find((d) => d.id === deviceId);
  if (!dev) return res.status(404).json({ error: "no_device" });
  if (!dev.ip || !dev.isapiPort || !dev.username) return res.status(400).json({ error: "sin_isapi" });
  const ch = Number(dev.channel) > 0 ? Number(dev.channel) : 1;
  const startMs = compactToMs(start), endMs = compactToMs(end);
  if (!Number.isFinite(startMs)) return res.status(400).json({ error: "bad_time" });
  try {
    // Grabación H.264+: el restream RTSP del NVR es indecodificable, pero el DOWNLOAD
    // de ContentMgmt entrega MPEG-PS limpio. El NVR graba el MAIN → track ch*100+1.
    // Buscamos el segmento que cubre el instante, lo bajamos y hacemos input-seek (ss).
    const seg = await searchSegment(dev, ch * 100 + 1, startMs - 60000, endMs);
    if (!seg) return res.status(404).json({ error: "no_recording", message: "No hay grabación en ese instante." });
    // El download arranca SIEMPRE al inicio del archivo del segmento (el NVR ignora
    // Range y no recorta por tiempo). El input-seek de ffmpeg no funciona sobre un
    // pipe → reproducimos como VOD desde el inicio del archivo y el reproductor
    // hace seek dentro de lo producido. Acotamos cuánto producir (hasta el fin de
    // la ventana pedida, máx 20 min) para no copiar archivos de ~80 min enteros.
    const dur = Math.min(1200, Math.max(60, (endMs - seg.segStartMs) / 1000));
    const s = await startHlsFromStream({ key: `pb:${deviceId}:${start}`, vod: true, dur, open: () => openDownload(dev, seg.uri) });
    res.json({ id: s.id, url: s.url });
  } catch (e) {
    res.status(502).json({ error: "pb_failed", message: e.message });
  }
});

// ── Snapshot ISAPI (póster instantáneo del muro) ────────────────────────────
// El server pide la imagen al NVR con Digest y la sirve; caché corta en memoria
// para no machacar al NVR cuando hay muchas tiles.
const SNAP_CACHE = new Map(); // deviceId → { ts, buf }
const SNAP_TTL = 500; // corto → near-live más fluido (~varios fps en el visor)
router.get("/camera/:id/snapshot", async (req, res) => {
  const id = String(req.params.id || "");
  let devices = [];
  try { devices = listConfig("devices"); } catch { /* store */ }
  const dev = devices.find((d) => d.id === id);
  if (!dev || !dev.ip || !dev.isapiPort || !dev.username) return res.status(404).end();
  const cached = SNAP_CACHE.get(id);
  if (cached && Date.now() - cached.ts < SNAP_TTL) {
    res.set("Content-Type", "image/jpeg"); res.set("Cache-Control", "no-store");
    return res.end(cached.buf);
  }
  const ch = Number(dev.channel) > 0 ? Number(dev.channel) : 1;
  try {
    const r = await digestGetBuffer({
      host: dev.ip, port: Number(dev.isapiPort), https: !!dev.isapiHttps,
      path: `/ISAPI/Streaming/channels/${ch}01/picture`,
      user: dev.username, pass: dev.password || "", timeoutMs: 6000,
    });
    if (r.status !== 200 || !r.buffer || r.buffer.length < 200 || !/image/i.test(r.contentType)) {
      return res.status(502).end();
    }
    SNAP_CACHE.set(id, { ts: Date.now(), buf: r.buffer });
    res.set("Content-Type", "image/jpeg"); res.set("Cache-Control", "no-store");
    res.end(r.buffer);
  } catch (e) {
    res.status(504).end();
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
  if (host && dev.username) {
    const port = Number(dev.isapiPort) || 80;
    const get = async (path) => {
      try { const r = await digestGetBuffer({ host, port, https: !!dev.isapiHttps, path, user: dev.username, pass: dev.password || "", timeoutMs: 4000 }); return r.status === 200 ? r.buffer.toString("utf8") : null; } catch { return null; }
    };
    const di = await get("/ISAPI/System/deviceInfo");
    if (di) { out.online = true; out.model = xtagInfo(di, "model") || out.model; out.firmware = xtagInfo(di, "firmwareVersion"); }
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
  res.json(out);
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
      siteId: d.siteId || null,
      site: siteName(d.siteId),
      streamUrl: d.streamUrl || null, // HLS/WebRTC/MJPEG (gateway) — opcional
      snapshotUrl: d.snapshotUrl || null, // imagen fija refrescable — opcional
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
    if (!/<enabled>\s*true\s*<\/enabled>/i.test(it)) continue;
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
];
const ANALYTICS_CACHE = new Map(); // deviceId → { ts, data }
async function getDeviceAnalytics(dev) {
  if (!dev || !dev.ip || !dev.isapiPort || !dev.username) return null;
  const cached = ANALYTICS_CACHE.get(dev.id);
  if (cached && Date.now() - cached.ts < 30000) return cached.data;
  const ch = Number(dev.channel) > 0 ? Number(dev.channel) : 1;
  const rules = [];
  for (const [pathName, kind] of ANALYTICS_TYPES) {
    try {
      const r = await digestGetBuffer({
        host: dev.ip, port: Number(dev.isapiPort), https: !!dev.isapiHttps,
        path: `/ISAPI/Smart/${pathName}/${ch}`, user: dev.username, pass: dev.password || "", timeoutMs: 6000,
      });
      if (r.status === 200) {
        const xml = r.buffer.toString("utf8");
        if (kind === "line") rules.push(...parseLineRules(xml));
        else rules.push(...parseRegionRules(xml, kind));
      }
    } catch { /* sigue con el resto */ }
  }
  const data = { channel: ch, space: 1000, rules };
  ANALYTICS_CACHE.set(dev.id, { ts: Date.now(), data });
  return data;
}
router.get("/camera/:id/analytics", async (req, res) => {
  let devices = [];
  try { devices = listConfig("devices"); } catch { /* store */ }
  const dev = devices.find((d) => d.id === String(req.params.id || ""));
  const data = await getDeviceAnalytics(dev);
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
      account: s.account || null,
      address: s.address || null,
      lat: Number.isFinite(Number(s.lat)) ? Number(s.lat) : null,
      lng: Number.isFinite(Number(s.lng)) ? Number(s.lng) : null,
    })),
  });
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

// Login con PIN (escalonado). Verifica el PIN contra el hash del operario y
// devuelve su perfil + rol. Para rol ADMIN, entrega además el X-Admin-Token
// (que el front guarda) para que la sección de configuración funcione sin pedir
// el token aparte. Sin PIN configurado → entra sin PIN (compatibilidad).
router.post("/auth/login", (req, res) => {
  const body = req.body || {};
  const operatorId = String(body.operatorId || "");
  const pin = body.pin == null ? "" : String(body.pin);
  let ops = [];
  try { ops = listConfig("operators"); } catch { /* store */ }
  const op = ops.find((o) => o.id === operatorId && o.active !== false);
  if (!op) return res.status(404).json({ ok: false, error: "no_operator" });
  if (op.pinHash) {
    if (!verifyPin(pin, op.pinHash)) return res.status(401).json({ ok: false, error: "bad_pin" });
  }
  const role = opRole(op);
  res.json({
    ok: true,
    operator: { operatorId: op.id, name: op.name || "Operario", skills: Array.isArray(op.skills) ? op.skills : [], role },
    adminToken: role === "admin" ? (config.adminToken || null) : null,
  });
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
