// ingest/alertStream.js — Recepción de eventos en TIEMPO REAL desde NVR Hikvision.
// Abre una conexión HTTP persistente al alertStream ISAPI de cada NVR (digest),
// recibe los <EventNotificationAlert>, filtra heartbeats, deduplica, enriquece con
// el dispositivo/sitio correctos y lo inyecta al pipeline de ingesta existente.
// OPT-IN por EVENTOS_ALERTSTREAM=1 (control en producción sin redeploy).
import crypto from "node:crypto";
import { list as listConfig } from "../config/store.js";
import { ingestRaw } from "../dispatch/pipeline.js";
import { log } from "../logger.js";

// ── Digest auth (dependency-free) ────────────────────────────────────────────
const md5 = (s) => crypto.createHash("md5").update(s).digest("hex");
function parseAuthHeader(h) {
  const o = {}; const re = /(\w+)=(?:"([^"]*)"|([^,\s]+))/g; let m;
  while ((m = re.exec(h))) o[m[1].toLowerCase()] = m[2] !== undefined ? m[2] : m[3];
  return o;
}
function digestAuth({ user, pass, method, uri, auth }) {
  const { realm = "", nonce = "", qop, opaque } = auth;
  const nc = "00000001"; const cnonce = crypto.randomBytes(8).toString("hex");
  const ha1 = md5(`${user}:${realm}:${pass}`); const ha2 = md5(`${method}:${uri}`);
  const useQop = qop ? (qop.split(",")[0] || "auth").trim() : null;
  const response = useQop ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:${useQop}:${ha2}`) : md5(`${ha1}:${nonce}:${ha2}`);
  let h = `Digest username="${user}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}"`;
  if (useQop) h += `, qop=${useQop}, nc=${nc}, cnonce="${cnonce}"`;
  if (opaque) h += `, opaque="${opaque}"`;
  return h;
}
function xmlTag(xml, name) {
  const re = new RegExp(`<(?:[\\w.-]+:)?${name}\\b[^>]*?>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${name}\\s*>`, "i");
  const m = re.exec(xml); return m ? m[1].trim() : undefined;
}

const ALERT_PATH = "/ISAPI/Event/notification/alertStream";
const DEDUP_MS = 45000;       // colapsa alertas repetidas de un mismo evento activo
const RECONNECT_MS = 5000;
const key = (s) => String(s || "").trim().toLowerCase().replace(/[\s_-]/g, "");

// Tipos ACCIONABLES (analíticas configuradas + alarmas). Se EXCLUYE el movimiento
// crudo (vmd/motion): en un sitio con decenas de cámaras es puro ruido (cientos/min).
// El movimiento se puede reactivar añadiéndolo aquí si se desea.
const KEEP = new Set([
  "linedetection", "fielddetection", "intrusion", "regionentrance", "regionexiting", "regionexit",
  "facedetection", "facesnap", "anpr", "vehicledetection",
  "io", "alarmlocal", "shelteralarm", "tamperdetection", "unattendedbaggage", "attendedbaggage", "loitering",
]);

// Clasifica un alert XML: ¿se ingesta? + campos crudos. Exportado para test.
export function classify(xml) {
  const eventType = xmlTag(xml, "eventType");
  const channelID = xmlTag(xml, "channelID") || xmlTag(xml, "dynChannelID");
  const eventState = (xmlTag(xml, "eventState") || "").toLowerCase();
  const k = key(eventType);
  if (!eventType) return { drop: true, reason: "no-type" };
  if (!channelID || channelID === "0") return { drop: true, reason: "heartbeat" }; // keep-alive sin canal
  if (!KEEP.has(k)) return { drop: true, reason: `type:${k}` };
  if (eventState && eventState !== "active") return { drop: true, reason: `state:${eventState}` };
  return {
    drop: false, k, channelID, eventState: eventState || "active",
    eventType, dateTime: xmlTag(xml, "dateTime"), ipAddress: xmlTag(xml, "ipAddress"),
    targetType: xmlTag(xml, "targetType") || xmlTag(xml, "detectionTarget"),
    regionID: xmlTag(xml, "RegionID") || xmlTag(xml, "regionID") || xmlTag(xml, "ID"),
  };
}

// ── Resolución de objetivos (NVR) y de cámara por canal ──────────────────────
function nvrTargets() {
  let devices = []; try { devices = listConfig("devices"); } catch { /* store */ }
  const out = [];
  for (const d of devices) {
    if (d.type !== "nvr" || !d.ip || !d.isapiPort || !d.username) continue;
    const tags = (d.tags || []).map(String);
    const slug = tags.includes("isapi:82") ? "srv2" : tags.includes("isapi:83") ? "srv1" : null;
    out.push({ id: d.id, name: d.name, host: d.ip, port: Number(d.isapiPort), user: d.username, pass: d.password || "", https: !!d.isapiHttps, slug, siteId: d.siteId || null });
  }
  return out;
}
function cameraFor(nvr, channelID) {
  let devices = []; try { devices = listConfig("devices"); } catch { /* store */ }
  const ch = String(channelID);
  let cam = nvr.slug && devices.find((d) => d.type !== "nvr" && (d.tags || []).map(String).includes(`nvr:${nvr.slug}`) && String(d.channel) === ch);
  if (!cam && nvr.siteId) cam = devices.find((d) => d.type !== "nvr" && d.siteId === nvr.siteId && String(d.channel) === ch);
  return cam || null;
}
function siteName(siteId) {
  if (!siteId) return null;
  let sites = []; try { sites = listConfig("sites"); } catch { /* store */ }
  const s = sites.find((x) => x.id === siteId); return s ? s.name : null;
}

const lastEmit = new Map(); // dedup `${nvrId}:${ch}:${type}` → ts

// image: Buffer JPEG de evidencia (cruce de línea / intrusión suben la foto del
// objeto detectado en el multipart). null si la notificación vino sin imagen.
function handleAlert(nvr, xml, image = null) {
  const c = classify(xml);
  if (c.drop) return;
  const dk = `${nvr.id}:${c.channelID}:${c.k}`;
  const now = Date.now();
  if (now - (lastEmit.get(dk) || 0) < DEDUP_MS) return;
  lastEmit.set(dk, now);

  const cam = cameraFor(nvr, c.channelID);
  const site = siteName((cam && cam.siteId) || nvr.siteId);
  // Objeto enriquecido → normalizeHikvision lo mapea (source.deviceId/site/etc.).
  const enriched = {
    eventType: c.eventType, eventState: c.eventState, channelID: c.channelID,
    dateTime: c.dateTime, ipAddress: c.ipAddress, targetType: c.targetType, regionID: c.regionID,
    deviceID: (cam && cam.id) || null,                 // → source.deviceId (playback/analíticas)
    channelName: (cam && cam.name) || xmlTag(xml, "channelName") || null, // → source.deviceName
    site,                                              // → source.site
  };
  const opts = image && image.length ? { image } : {};
  ingestRaw("hikvision", enriched, opts)
    .then((ev) => log.info(`alertStream[${nvr.name}] ${c.k} ch${c.channelID}${image ? " +foto" : ""} → ${ev.type} ${cam ? `(${cam.name})` : ""} [${ev.status}]`))
    .catch((e) => log.warn(`alertStream ingest err: ${e.message}`));
}

// ── Parser de multipart binario (XML + JPEG de evidencia) ────────────────────
function parsePartHeaders(headBuf) {
  const o = {};
  for (const ln of headBuf.toString("latin1").split(/\r\n/)) {
    const i = ln.indexOf(":"); if (i > 0) o[ln.slice(0, i).trim().toLowerCase()] = ln.slice(i + 1).trim();
  }
  return o;
}
const CRLF2 = Buffer.from("\r\n\r\n");
// Empareja cada XML con la imagen que lo acompaña (llegan como partes consecutivas).
// Si pasa un breve tiempo sin imagen, emite el evento sin foto (no se pierde).
function makeMultipartConsumer(nvr, boundary) {
  const delim = Buffer.from(`--${boundary}`);
  let pending = null; // { xml, timer }
  const flush = (image) => {
    if (!pending) return;
    const { xml, timer } = pending; clearTimeout(timer); pending = null;
    try { handleAlert(nvr, xml, image); } catch { /* sigue */ }
  };
  const onPart = (headers, body) => {
    const ct = headers["content-type"] || "";
    const isImg = /image\/jpeg/i.test(ct) || (body.length > 2 && body[0] === 0xff && body[1] === 0xd8);
    const isXml = /xml/i.test(ct) || body.indexOf("<EventNotificationAlert") >= 0;
    if (isImg) { if (pending) flush(body); /* imagen huérfana → ignorar */ }
    else if (isXml) { flush(null); pending = { xml: body.toString("utf8"), timer: setTimeout(() => flush(null), 1500) }; }
  };
  return (buf) => {
    for (;;) {
      const start = buf.indexOf(delim);
      if (start < 0) break;
      const next = buf.indexOf(delim, start + delim.length);
      if (next < 0) break;                 // parte incompleta → espera más datos
      const part = buf.slice(start + delim.length, next);
      buf = buf.slice(next);               // conserva el delimitador para la próxima vuelta
      const sep = part.indexOf(CRLF2);
      if (sep >= 0) {
        const headers = parsePartHeaders(part.slice(0, sep));
        let body = part.slice(sep + 4);
        if (body.length >= 2 && body[body.length - 2] === 13 && body[body.length - 1] === 10) body = body.slice(0, -2);
        if (body.length) onPart(headers, body);
      }
    }
    if (buf.length > 6_000_000) buf = buf.slice(-1_000_000); // tope de seguridad
    return buf;
  };
}

async function runNvr(nvr) {
  const url = `${nvr.https ? "https" : "http"}://${nvr.host}:${nvr.port}${ALERT_PATH}`;
  for (;;) {
    try {
      let res = await fetch(url);
      if (res.status === 401) {
        const wa = res.headers.get("www-authenticate") || "";
        const authz = /digest/i.test(wa)
          ? digestAuth({ user: nvr.user, pass: nvr.pass, method: "GET", uri: ALERT_PATH, auth: parseAuthHeader(wa) })
          : "Basic " + Buffer.from(`${nvr.user}:${nvr.pass}`).toString("base64");
        res = await fetch(url, { headers: { Authorization: authz } });
      }
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      // ¿multipart? → parser binario (XML + JPEG de evidencia). Si no, modo texto.
      const ctype = res.headers.get("content-type") || "";
      const bm = /boundary="?([^";]+)"?/i.exec(ctype);
      log.info(`alertStream[${nvr.name}] conectado (${nvr.host}:${nvr.port})${bm ? " [multipart+foto]" : ""}`);
      const reader = res.body.getReader();
      if (bm) {
        const consume = makeMultipartConsumer(nvr, bm[1].trim());
        let buf = Buffer.alloc(0);
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf = Buffer.concat([buf, Buffer.from(value)]);
          buf = consume(buf);
        }
      } else {
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += Buffer.from(value).toString("utf8");
          const re = /<EventNotificationAlert[\s\S]*?<\/EventNotificationAlert>/i;
          let m;
          while ((m = re.exec(buf))) { const x = m[0]; buf = buf.slice(m.index + x.length); try { handleAlert(nvr, x); } catch { /* sigue */ } }
          if (buf.length > 200000) buf = buf.slice(-50000);
        }
      }
      log.warn(`alertStream[${nvr.name}] stream terminó, reconectando…`);
    } catch (e) {
      log.warn(`alertStream[${nvr.name}] error: ${e.message}; reintento en ${RECONNECT_MS / 1000}s`);
    }
    await new Promise((r) => setTimeout(r, RECONNECT_MS));
  }
}

let started = false;
export function startAlertStreams() {
  if (started) return;
  if (String(process.env.EVENTOS_ALERTSTREAM || "") !== "1") {
    log.info("alertStream: deshabilitado (EVENTOS_ALERTSTREAM!=1)");
    return;
  }
  started = true;
  const nvrs = nvrTargets();
  if (!nvrs.length) { log.warn("alertStream: sin NVR con credenciales/puerto ISAPI"); return; }
  for (const nvr of nvrs) runNvr(nvr);
  log.info(`alertStream: escuchando ${nvrs.length} NVR (dedup ${DEDUP_MS / 1000}s)`);
}

export default { startAlertStreams, classify };
