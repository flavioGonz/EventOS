// http/akuvoxActionUrls.js — Auto-configurar las Action URLs de un portero Akuvox.
//
// Un Action URL es un GET saliente que el equipo dispara al ocurrir un evento
// (tarjeta/PIN/rostro/QR válido·inválido, relé, entrada, sabotaje, llamada). En vez
// de cargarlos a mano uno por uno en la web del equipo, este handler los escribe
// por la HTTP API del portero apuntando a la ingesta de EventOS, y verifica
// releyendo la config.
//
// Contrato:
//   POST /api/admin/devices/:id/akuvox/action-urls   body { mode: 'probe'|'apply' }
//   - probe: conecta + lee config + arma el plan, NO escribe.
//   - apply: además escribe y verifica (config/get).
// Respuesta: { reachable, authed, steps[], events[], summary, device, discoveredKeys }
//
// Realidad verificada en campo (2026-08, Akuvox E16C V2.0 fw 216.30.10.141):
//  · La HTTP API va por HTTPS con **cert self-signed** → hay que NO validar el cert
//    (fetch/digestFetch lo rechazaban → "no respondió"). Usamos node https con
//    rejectUnauthorized:false.
//  · Auth = **Basic** (algunos modelos Digest; probamos Basic y caemos a Digest).
//  · Las Action URL viven en **Config.Features.ACTIONURL.*** (claves reales, no las
//    de INPUT del manual R29).
//  · **config/set NO acepta POST** en el E16 (`unsupport action`) → se escribe con
//    **GET per-key**: /api/config/set?<Config.Key>=<url-encoded value>.
import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import { config } from "../config.js";
import { log } from "../logger.js";
import * as store from "../config/store.js";

// Catálogo de eventos → variables Akuvox → clave real de config. El nombre del
// evento va codificado en la URL (?event=…) porque varios comparten variable.
export const AKUVOX_EVENTS = [
  { event: "validcard",    label: "Tarjeta válida",    icon: "shieldcheck", vars: "card=$card_sn",         cfg: "ValidCardEntered" },
  { event: "invalidcard",  label: "Tarjeta inválida",  icon: "shield",      vars: "card=$card_sn",         cfg: "InvalidCardEntered" },
  { event: "validcode",    label: "PIN válido",        icon: "shieldcheck", vars: "code=$code",            cfg: "ValidCodeEntered" },
  { event: "invalidcode",  label: "PIN inválido",      icon: "shield",      vars: "code=$code",            cfg: "InvalidCodeEntered" },
  { event: "validface",    label: "Rostro válido",     icon: "face",        vars: "unlocktype=$unlocktype", cfg: "ValidFaceRecognition" },
  { event: "invalidface",  label: "Rostro inválido",   icon: "face",        vars: "unlocktype=$unlocktype", cfg: "InvalidFaceRecognition" },
  { event: "validqr",      label: "QR válido",         icon: "hash",        vars: "unlocktype=$unlocktype", cfg: null },
  { event: "invalidqr",    label: "QR inválido",       icon: "hash",        vars: "unlocktype=$unlocktype", cfg: null },
  { event: "relaytrigger", label: "Relé disparado",    icon: "bolt",        vars: "relay=$relay1status",   cfg: "RelayATriggered" },
  { event: "relayclose",   label: "Relé cerrado",      icon: "bolt",        vars: "relay=$relay1status",   cfg: "RelayAClosed" },
  { event: "inputtrigger", label: "Entrada disparada", icon: "device",      vars: "input=$input1status",   cfg: "InputATriggered" },
  { event: "inputclose",   label: "Entrada cerrada",   icon: "device",      vars: "input=$input1status",   cfg: "InputAClosed" },
  { event: "tampertri",    label: "Sabotaje (tamper)", icon: "siren",       vars: "alarm=$alarmstatus",    cfg: "AlarmTriggered" },
  { event: "breakin",      label: "Break-in (forzado)",icon: "siren",       vars: "input=$input1status",   cfg: "InputBreakIn" },
  { event: "makecall",     label: "Llamada entrante",  icon: "phone",       vars: "remote=$remote",        cfg: "MakeCall" },
  { event: "hangup",       label: "Llamada colgada",   icon: "phone",       vars: "remote=$remote",        cfg: "HangUp" },
];
const CFG_PREFIX = "Config.Features.ACTIONURL.";

// ── Cliente HTTP tolerante a cert self-signed (Basic, con fallback Digest) ────
const _md5 = (s) => crypto.createHash("md5").update(s).digest("hex");
function _parseAuth(h) {
  const o = {};
  const re = /(\w+)=(?:"([^"]*)"|([^,\s]+))/g;
  let m;
  while ((m = re.exec(h))) o[m[1].toLowerCase()] = m[2] !== undefined ? m[2] : m[3];
  return o;
}
function _digest({ user, pass, method, uri, auth }) {
  const { realm = "", nonce = "", qop, opaque } = auth;
  const nc = "00000001", cnonce = crypto.randomBytes(8).toString("hex");
  const ha1 = _md5(`${user}:${realm}:${pass}`), ha2 = _md5(`${method}:${uri}`);
  const useQop = qop ? (qop.split(",")[0] || "auth").trim() : null;
  const response = useQop ? _md5(`${ha1}:${nonce}:${nc}:${cnonce}:${useQop}:${ha2}`) : _md5(`${ha1}:${nonce}:${ha2}`);
  let s = `Digest username="${user}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}"`;
  if (useQop) s += `, qop=${useQop}, nc=${nc}, cnonce="${cnonce}"`;
  if (opaque) s += `, opaque="${opaque}"`;
  return s;
}
function rawReq({ host, port, secure, path, method = "GET", headers = {}, timeoutMs = 7000 }) {
  return new Promise((resolve, reject) => {
    const mod = secure ? https : http;
    const req = mod.request({ host, port, path, method, headers, rejectUnauthorized: false, timeout: timeoutMs }, (res) => {
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (buf += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: buf }));
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.end();
  });
}
async function apiGet(opt, path) {
  const basic = "Basic " + Buffer.from(`${opt.user}:${opt.pass}`).toString("base64");
  let res = await rawReq({ ...opt, path, headers: { Authorization: basic } });
  if (res.status === 401) {
    const wa = res.headers["www-authenticate"] || "";
    if (/digest/i.test(wa)) {
      res = await rawReq({ ...opt, path, headers: { Authorization: _digest({ user: opt.user, pass: opt.pass, method: "GET", uri: path, auth: _parseAuth(wa) }) } });
    }
  }
  let json = null;
  try { json = JSON.parse(res.text); } catch { /* no-json */ }
  return { status: res.status, json, text: res.text };
}

function recount(events) {
  const s = { total: events.length, auto: 0, manual: 0, failed: 0, configured: 0 };
  for (const e of events) {
    if (e.status === "verified" || e.status === "written" || e.status === "planned") s.auto++;
    else if (e.status === "manual") s.manual++;
    else if (e.status === "failed") s.failed++;
    if (e.configured) s.configured++;
  }
  return s;
}

export async function akuvoxActionUrlsHandler(req, res) {
  const dev = store.get("devices", req.params.id);
  if (!dev) return res.status(404).json({ error: "not_found" });
  const mode = req.body && req.body.mode === "apply" ? "apply" : "probe";

  const proto = req.get("X-Forwarded-Proto") || req.protocol;
  const host = req.get("X-Forwarded-Host") || req.get("Host") || `127.0.0.1:${config.port}`;
  const base = `${proto}://${host}`;
  const token = config.ingestToken;

  const devHost = String(dev.ip || dev.camIp || "").replace(/^https?:\/\//, "").replace(/:\d+$/, "");
  const port = Number(dev.isapiPort) || (dev.isapiHttps ? 443 : 80);
  const secure = dev.isapiHttps !== undefined ? !!dev.isapiHttps : port === 443 || port === 8082;
  const user = dev.username || "";
  const pass = dev.password || "";
  const opt = { host: devHost, port, secure, user, pass, timeoutMs: 7000 };

  const mkUrl = (e) =>
    `${base}/api/ingest/akuvox?token=${token}&event=${e.event}&${e.vars}` +
    `&mac=$mac&ip=$ip&model=$model&firmware=$firmware`;
  const events = AKUVOX_EVENTS.map((e) => ({ event: e.event, label: e.label, icon: e.icon, vars: e.vars, cfg: e.cfg, url: mkUrl(e) }));

  const steps = [];
  const out = {
    mode, deviceId: dev.id, deviceName: dev.name, host: devHost, port,
    hasCreds: !!(user && pass), reachable: false, authed: false, base,
    device: null, discoveredKeys: [], steps, events: [], summary: recount([]),
  };
  const finish = (evs) => { out.events = evs; out.summary = recount(evs); res.json(out); };

  if (!devHost || !user) {
    steps.push({ key: "connect", ok: false, detail: !devHost ? "El portero no tiene IP cargada en la ficha." : "Falta usuario del HTTP API en la ficha." });
    steps.push({ key: "read", ok: false, detail: "—" });
    steps.push({ key: "write", ok: false, detail: "—" });
    steps.push({ key: "verify", ok: false, detail: "—" });
    return finish(events.map((e) => ({ ...e, key: null, status: "manual", note: "Cargá IP + usuario/clave del portero" })));
  }

  // 1) CONECTAR + identidad (system/info). Probamos el esquema de la ficha y, si la
  //    conexión falla, el otro (tolera el flag https mal seteado).
  let liveOpt = null;
  for (const sc of (secure ? [true, false] : [false, true])) {
    const o = { ...opt, secure: sc };
    try {
      const r = await apiGet(o, "/api/system/info");
      liveOpt = o; out.reachable = true;
      if (r.json && r.json.retcode === 0 && r.json.data) {
        out.authed = true;
        const d = r.json.data.Status || r.json.data;
        out.device = { model: d.Model || null, firmware: d.FirmwareVersion || d.Firmware || null, mac: d.MAC || null, ip: d.IPAddress || devHost };
        steps.push({ key: "connect", ok: true, detail: "Conectado y autenticado con el portero" });
      } else if (r.status === 401) {
        steps.push({ key: "connect", ok: true, detail: "Responde pero la autenticación falló — revisá usuario/clave del HTTP API" });
      } else {
        steps.push({ key: "connect", ok: true, detail: `Responde (HTTP ${r.status}) — revisá que el HTTP API esté habilitado` });
      }
      break;
    } catch (e) {
      liveOpt = o;
      if (sc === (secure ? false : true)) steps.push({ key: "connect", ok: false, detail: `No se pudo conectar: ${e.message}` });
    }
  }

  if (!out.reachable) {
    steps.push({ key: "read", ok: false, detail: "Equipo no alcanzable" });
    steps.push({ key: "write", ok: false, detail: "Nada que escribir (sin conexión)" });
    steps.push({ key: "verify", ok: false, detail: "—" });
    return finish(events.map((e) => ({ ...e, key: e.cfg ? CFG_PREFIX + e.cfg : null, status: "manual", note: "Equipo offline — pegá la URL a mano o reintentá" })));
  }

  // 2) LEER config → confirmar qué claves de Action URL existen en este equipo.
  let cfg = {};
  try {
    const r = await apiGet(liveOpt, "/api/config/get");
    cfg = (r.json && r.json.data) || {};
    out.discoveredKeys = Object.keys(cfg).filter((k) => k.startsWith(CFG_PREFIX));
    steps.push({ key: "read", ok: true, detail: `Config leída — ${Object.keys(cfg).length} claves (${out.discoveredKeys.length} de Action URL)` });
  } catch (e) {
    steps.push({ key: "read", ok: false, detail: `No se pudo leer la config: ${e.message}` });
  }

  // 3) Plan: cada evento con clave real que EXISTA en el equipo es auto-escribible.
  const known = new Set(out.discoveredKeys);
  const planned = events.map((e) => {
    const key = e.cfg ? CFG_PREFIX + e.cfg : null;
    if (!key || (out.discoveredKeys.length && !known.has(key))) {
      return { ...e, key, status: "manual", note: key ? "No expuesta por este modelo — pegala a mano" : "Sin clave en este modelo — pegala a mano" };
    }
    const cur = cfg[key];
    const configured = cur != null && String(cur).includes("/api/ingest/akuvox");
    return { ...e, key, status: "planned", configured, note: configured ? "Ya configurada en el portero" : "" };
  });

  if (mode === "probe") {
    const n = planned.filter((e) => e.status === "planned").length;
    steps.push({ key: "write", ok: true, detail: `Plan listo — ${n} claves auto-escribibles (previsualización)` });
    steps.push({ key: "verify", ok: true, detail: "Previsualización — sin verificación" });
    return finish(planned);
  }

  // 4) ESCRIBIR — GET per-key (config/set?<key>=<value>). El E16 NO acepta POST.
  const toWrite = planned.filter((e) => e.status === "planned");
  let okCount = 0;
  for (const e of toWrite) {
    try {
      const path = `/api/config/set?${encodeURIComponent(e.key)}=${encodeURIComponent(e.url)}`;
      const r = await apiGet(liveOpt, path);
      if (r.json && r.json.retcode === 0) okCount++;
    } catch { /* sigue */ }
  }
  // Asegurar Action URL habilitado.
  try { await apiGet(liveOpt, `/api/config/set?${encodeURIComponent(CFG_PREFIX + "Enable")}=1`); } catch { /* opcional */ }
  steps.push({ key: "write", ok: okCount > 0, detail: okCount ? `Escritas ${okCount}/${toWrite.length} Action URLs en el portero` : "No se pudo escribir ninguna (revisá permisos del usuario del HTTP API)" });

  // 5) VERIFICAR — releer config y comparar.
  let vcfg = {};
  try {
    const r = await apiGet(liveOpt, "/api/config/get");
    vcfg = (r.json && r.json.data) || {};
    steps.push({ key: "verify", ok: true, detail: "Config releída para confirmar" });
  } catch (e) {
    steps.push({ key: "verify", ok: false, detail: `No se pudo verificar: ${e.message}` });
  }

  const finalEvents = planned.map((e) => {
    if (e.status === "manual") return e;
    const got = vcfg[e.key];
    if (got != null && String(got).includes("/api/ingest/akuvox")) return { ...e, status: "verified", note: "Confirmado en el portero" };
    if (okCount > 0) return { ...e, status: "written", note: "Escrito (sin confirmación exacta)" };
    return { ...e, status: "failed", note: "No se pudo escribir en el equipo" };
  });

  log.info(`akuvox action-urls[${mode}] ${dev.name}: reachable=${out.reachable} auth=${out.authed} auto=${recount(finalEvents).auto}/${finalEvents.length}`);
  finish(finalEvents);
}

export default { akuvoxActionUrlsHandler, AKUVOX_EVENTS };
