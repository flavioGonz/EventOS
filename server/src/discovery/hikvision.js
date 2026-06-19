// discovery/hikvision.js — descubrimiento de equipos vía ISAPI de Hikvision.
// Sondea un NVR/cámara (con credenciales) y enumera: info del equipo, canales
// (cámaras del NVR), analíticas/eventos configurados y rutas de stream RTSP.
// Cliente HTTP con Digest auth (sin dependencias). Tolerante: nunca lanza hacia
// afuera; devuelve resultados parciales + lista de errores.
import crypto from "node:crypto";

const md5 = (s) => crypto.createHash("md5").update(s).digest("hex");

// ── Digest / Basic auth ──────────────────────────────────────────────────────
function parseAuthHeader(header) {
  const out = {};
  const re = /(\w+)=(?:"([^"]*)"|([^,\s]+))/g;
  let m;
  while ((m = re.exec(header))) out[m[1].toLowerCase()] = m[2] !== undefined ? m[2] : m[3];
  return out;
}

function digestAuth({ user, pass, method, uri, auth }) {
  const { realm = "", nonce = "", qop, opaque } = auth;
  const nc = "00000001";
  const cnonce = crypto.randomBytes(8).toString("hex");
  const ha1 = md5(`${user}:${realm}:${pass}`);
  const ha2 = md5(`${method}:${uri}`);
  const useQop = qop ? (qop.split(",")[0] || "auth").trim() : null;
  const response = useQop
    ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:${useQop}:${ha2}`)
    : md5(`${ha1}:${nonce}:${ha2}`);
  let h = `Digest username="${user}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}"`;
  if (useQop) h += `, qop=${useQop}, nc=${nc}, cnonce="${cnonce}"`;
  if (opaque) h += `, opaque="${opaque}"`;
  return h;
}

async function isapiGet({ host, port, https, path, user, pass, timeoutMs = 5000 }) {
  const url = `${https ? "https" : "http"}://${host}:${port}${path}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let res = await fetch(url, { signal: ctrl.signal, redirect: "manual" });
    if (res.status === 401) {
      const wa = res.headers.get("www-authenticate") || "";
      const headers = {};
      if (/digest/i.test(wa)) {
        headers.Authorization = digestAuth({ user, pass, method: "GET", uri: path, auth: parseAuthHeader(wa) });
      } else {
        headers.Authorization = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
      }
      res = await fetch(url, { signal: ctrl.signal, headers, redirect: "manual" });
    }
    const text = await res.text();
    return { status: res.status, text };
  } finally {
    clearTimeout(t);
  }
}

// ── Parsers XML tolerantes (Hikvision ISAPI) ─────────────────────────────────
function tag(xml, name) {
  if (!xml) return undefined;
  const m = new RegExp(`<(?:[\\w.-]+:)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${name}\\s*>`, "i").exec(xml);
  return m ? m[1].trim() : undefined;
}
function blocks(xml, name) {
  if (!xml) return [];
  const re = new RegExp(`<(?:[\\w.-]+:)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${name}\\s*>`, "gi");
  const out = [];
  let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}

function parseDeviceInfo(xml) {
  return {
    name: tag(xml, "deviceName") || null,
    model: tag(xml, "model") || null,
    serial: tag(xml, "serialNumber") || null,
    firmware: tag(xml, "firmwareVersion") || null,
    deviceType: tag(xml, "deviceType") || null,
    mac: tag(xml, "macAddress") || null,
    channels: tag(xml, "videoInputPortNums") || tag(xml, "videoInputChannels") || null,
  };
}

function parseProxyChannels(xml) {
  return blocks(xml, "InputProxyChannel").map((b) => {
    const src = tag(b, "sourceInputPortDescriptor") || b;
    return {
      id: tag(b, "id") || null,
      name: tag(b, "name") || tag(src, "name") || null,
      ip: tag(src, "ipAddress") || tag(src, "addressFormatType") || null,
      port: tag(src, "managePortNo") || tag(src, "srcInputPort") || null,
      online: /true|online/i.test(tag(b, "online") || ""),
    };
  });
}

function parseVideoChannels(xml) {
  return blocks(xml, "VideoInputChannel").map((b) => ({
    id: tag(b, "id") || null,
    name: tag(b, "name") || null,
    res: tag(b, "resDesc") || null,
  }));
}

function parseStreams(xml, { host, port }) {
  return blocks(xml, "StreamingChannel").map((b) => {
    const id = tag(b, "id") || "";
    const codec = tag(b, "videoCodecType") || null;
    const w = tag(b, "videoResolutionWidth");
    const h = tag(b, "videoResolutionHeight");
    return {
      id,
      codec,
      resolution: w && h ? `${w}x${h}` : null,
      rtsp: id ? `rtsp://${host}:554/Streaming/channels/${id}` : null,
    };
  });
}

// Eventos/analíticas configuradas: cada <EventTrigger> trae el tipo + el canal.
const EVENT_TYPE_LABEL = {
  linedetection: "Cruce de línea", fielddetection: "Intrusión", regionEntrance: "Entrada a zona",
  regionExiting: "Salida de zona", VMD: "Movimiento", videoloss: "Pérdida de video",
  tamperdetection: "Sabotaje", facedetection: "Rostro", scenechangedetection: "Cambio de escena",
};
function parseTriggers(xml) {
  return blocks(xml, "EventTrigger").map((b) => {
    const type = tag(b, "eventType") || null;
    return {
      type,
      label: (type && EVENT_TYPE_LABEL[type]) || type,
      channel: tag(b, "videoInputChannelID") || tag(b, "dynVideoInputChannelID") || tag(b, "id") || null,
      notify: /center|HTTP|email/i.test(b),
    };
  });
}

// ── API ──────────────────────────────────────────────────────────────────────
export async function discover({ host, port, user, pass, https = false }) {
  const opt = { host: String(host || "").trim(), port: Number(port) || (https ? 443 : 80), https: !!https, user, pass };
  const out = { host: opt.host, port: opt.port, device: null, channels: [], streams: [], analytics: [], errors: [] };
  if (!opt.host || !user) { out.errors.push("Faltan host o credenciales."); return out; }

  const probe = async (path, onOk) => {
    try {
      const r = await isapiGet({ ...opt, path });
      if (r.status === 200) onOk(r.text);
      else if (r.status === 401) out.errors.push(`${path}: 401 (credenciales inválidas)`);
      else out.errors.push(`${path}: HTTP ${r.status}`);
      return true; // conectó (aunque el status no sea 200)
    } catch (e) {
      out.errors.push(`${path}: ${e.name === "AbortError" ? "timeout" : e.message}`);
      return false;
    }
  };

  // El primer sondeo valida conectividad: si no conecta, no insistimos con el resto.
  const connected = await probe("/ISAPI/System/deviceInfo", (t) => { out.device = parseDeviceInfo(t); });
  if (!connected) {
    out.errors.unshift(`No se pudo conectar con ${opt.host}:${opt.port}. Revisa IP/puerto/red.`);
    return out;
  }

  await probe("/ISAPI/ContentMgmt/InputProxy/channels", (t) => { out.channels = parseProxyChannels(t); });
  if (!out.channels.length) {
    await probe("/ISAPI/System/Video/inputs/channels", (t) => { out.channels = parseVideoChannels(t); });
  }
  await probe("/ISAPI/Streaming/channels", (t) => { out.streams = parseStreams(t, opt); });
  await probe("/ISAPI/Event/triggers", (t) => { out.analytics = parseTriggers(t); });

  return out;
}

export default { discover };
