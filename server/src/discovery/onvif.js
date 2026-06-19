// discovery/onvif.js — descubrimiento de equipos vía ONVIF (Perfil S/T/M).
// SOAP 1.2 + WS-Security UsernameToken (PasswordDigest), sin dependencias.
// Sondea device_service: info del equipo, servicios, perfiles (canales),
// rutas RTSP y analíticas/eventos configurados. Tolerante: nunca lanza hacia
// afuera; devuelve resultados parciales + lista de errores.
import crypto from "node:crypto";

// ── XML helpers (namespace-tolerantes) ───────────────────────────────────────
const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&apos;");

function tag(xml, name) {
  if (!xml) return undefined;
  const m = new RegExp(`<(?:[\\w.-]+:)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${name}\\s*>`, "i").exec(xml);
  return m ? m[1].trim() : undefined;
}
function blocks(xml, name) {
  if (!xml) return [];
  const re = new RegExp(`<(?:[\\w.-]+:)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${name}\\s*>`, "gi");
  const out = []; let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}
// Igual que blocks() pero devuelve también los atributos de la etiqueta de apertura.
function blocksAttr(xml, name) {
  if (!xml) return [];
  const re = new RegExp(`<(?:[\\w.-]+:)?${name}\\b([^>]*)>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${name}\\s*>`, "gi");
  const out = []; let m;
  while ((m = re.exec(xml))) out.push({ attrs: m[1] || "", body: m[2] || "" });
  // Etiquetas auto-cerradas (<X .../>) — sin cuerpo.
  const re2 = new RegExp(`<(?:[\\w.-]+:)?${name}\\b([^>]*)\\/>`, "gi");
  while ((m = re2.exec(xml))) out.push({ attrs: m[1] || "", body: "" });
  return out;
}
function attr(attrs, name) {
  const m = new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "i").exec(attrs || "");
  return m ? m[1] : null;
}

// ── SOAP / WS-Security ────────────────────────────────────────────────────────
function securityHeader(user, pass) {
  if (!user) return "";
  const created = new Date().toISOString();
  const nonce = crypto.randomBytes(16);
  const digest = crypto.createHash("sha1")
    .update(Buffer.concat([nonce, Buffer.from(created, "utf8"), Buffer.from(pass || "", "utf8")]))
    .digest("base64");
  return `<s:Header><wsse:Security s:mustUnderstand="1"`
    + ` xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd"`
    + ` xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">`
    + `<wsse:UsernameToken><wsse:Username>${esc(user)}</wsse:Username>`
    + `<wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${digest}</wsse:Password>`
    + `<wsse:Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${nonce.toString("base64")}</wsse:Nonce>`
    + `<wsu:Created>${created}</wsu:Created></wsse:UsernameToken></wsse:Security></s:Header>`;
}
function envelope(bodyXml, user, pass) {
  return `<?xml version="1.0" encoding="UTF-8"?>`
    + `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">`
    + `${securityHeader(user, pass)}<s:Body>${bodyXml}</s:Body></s:Envelope>`;
}

async function soap({ url, body, user, pass, timeoutMs = 6000 }) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/soap+xml; charset=utf-8" },
      body: envelope(body, user, pass),
      signal: ctrl.signal, redirect: "manual",
    });
    const text = await res.text();
    return { status: res.status, text };
  } finally { clearTimeout(t); }
}

// ── Cuerpos SOAP ──────────────────────────────────────────────────────────────
const B = {
  deviceInfo: `<GetDeviceInformation xmlns="http://www.onvif.org/ver10/device/wsdl"/>`,
  services: `<GetServices xmlns="http://www.onvif.org/ver10/device/wsdl"><IncludeCapability>false</IncludeCapability></GetServices>`,
  profiles2: `<GetProfiles xmlns="http://www.onvif.org/ver20/media/wsdl"><Type>All</Type></GetProfiles>`,
  profiles1: `<GetProfiles xmlns="http://www.onvif.org/ver10/media/wsdl"/>`,
  streamUri2: (token) => `<GetStreamUri xmlns="http://www.onvif.org/ver20/media/wsdl"><Protocol>RTSP</Protocol><ProfileToken>${esc(token)}</ProfileToken></GetStreamUri>`,
  streamUri1: (token) => `<trt:GetStreamUri xmlns:trt="http://www.onvif.org/ver10/media/wsdl">`
    + `<trt:StreamSetup><tt:Stream xmlns:tt="http://www.onvif.org/ver10/schema">RTP-Unicast</tt:Stream>`
    + `<tt:Transport xmlns:tt="http://www.onvif.org/ver10/schema"><tt:Protocol>RTSP</tt:Protocol></tt:Transport></trt:StreamSetup>`
    + `<trt:ProfileToken>${esc(token)}</trt:ProfileToken></trt:GetStreamUri>`,
  analyticsModules: (token) => `<GetAnalyticsModules xmlns="http://www.onvif.org/ver20/analytics/wsdl"><ConfigurationToken>${esc(token)}</ConfigurationToken></GetAnalyticsModules>`,
  eventProps: `<GetEventProperties xmlns="http://www.onvif.org/ver10/events/wsdl"/>`,
};

// ── Etiquetas legibles de analíticas/eventos ONVIF ───────────────────────────
const ANALYTIC_LABEL = {
  CellMotionEngine: "Movimiento (celdas)", CellMotionDetector: "Movimiento (celdas)",
  MotionRegionDetector: "Movimiento por región", MotionDetector: "Movimiento",
  LineDetector: "Cruce de línea", LineCrossing: "Cruce de línea",
  FieldDetector: "Intrusión / zona", IntrusionDetector: "Intrusión",
  TamperDetector: "Sabotaje", DeviceTamper: "Sabotaje",
  FaceDetector: "Rostro", FaceRecognition: "Rostro",
  ObjectInField: "Objeto en zona", LoiteringDetector: "Merodeo",
  CountAggregation: "Conteo", CountingRule: "Conteo", Counting: "Conteo",
  LicensePlateDetector: "Matrícula (LPR)", LicensePlateRecognition: "Matrícula (LPR)",
  AudioDetector: "Detección de audio", AudioClassification: "Clasificación de audio",
};
function labelFor(type) {
  if (!type) return null;
  const leaf = String(type).split(":").pop().split("/").pop();
  return ANALYTIC_LABEL[leaf] || leaf;
}

function parseDeviceInfo(xml) {
  if (!xml) return null;
  const name = tag(xml, "Manufacturer");
  const model = tag(xml, "Model");
  if (!name && !model) return null;
  return {
    name: [name, model].filter(Boolean).join(" ") || null,
    model: model || null,
    serial: tag(xml, "SerialNumber") || null,
    firmware: tag(xml, "FirmwareVersion") || null,
    deviceType: "ONVIF",
    mac: tag(xml, "HardwareId") || null,
  };
}

function parseServices(xml) {
  const out = {};
  for (const b of blocks(xml, "Service")) {
    const ns = tag(b, "Namespace");
    const xaddr = tag(b, "XAddr");
    if (ns && xaddr) out[ns] = xaddr;
  }
  return out;
}

// Perfiles → canales + tokens de analítica. Funciona con Media2 y Media1.
function parseProfiles(xml) {
  return blocksAttr(xml, "Profiles").map(({ attrs, body }, i) => {
    const token = attr(attrs, "token") || tag(body, "token") || `prof${i + 1}`;
    const venc = tag(body, "VideoEncoderConfiguration") || body;
    const w = tag(venc, "Width"); const h = tag(venc, "Height");
    const analytics = blocksAttr(body, "VideoAnalyticsConfiguration")[0] || blocksAttr(body, "Analytics")[0];
    return {
      token,
      name: tag(body, "Name") || token,
      codec: tag(venc, "Encoding") || null,
      resolution: w && h ? `${w}x${h}` : null,
      analyticsToken: analytics ? (attr(analytics.attrs, "token") || tag(analytics.body, "token") || null) : null,
    };
  });
}

function parseStreamUri(xml) {
  return tag(xml, "Uri") || null;
}

function parseAnalyticsModules(xml, channelName) {
  const out = [];
  for (const { attrs } of blocksAttr(xml, "AnalyticsModule")) {
    const type = attr(attrs, "Type");
    out.push({ type, label: labelFor(type) || attr(attrs, "Name") || "Analítica", channel: channelName });
  }
  return out;
}

// ── API ──────────────────────────────────────────────────────────────────────
export async function discover({ host, port, user, pass, https = false }) {
  const h = String(host || "").trim();
  const p = Number(port) || (https ? 443 : 80);
  const scheme = https ? "https" : "http";
  const out = { host: h, port: p, protocol: "onvif", device: null, channels: [], streams: [], analytics: [], errors: [] };
  if (!h || !user) { out.errors.push("Faltan host o credenciales."); return out; }

  const deviceUrl = `${scheme}://${h}:${p}/onvif/device_service`;

  const call = async (url, body, label) => {
    try {
      const r = await soap({ url, body, user, pass });
      if (r.status === 200 && !/Fault>/i.test(r.text)) return r.text;
      if (r.status === 401 || /NotAuthorized|FailedAuthentication/i.test(r.text)) out.errors.push(`${label}: credenciales inválidas (401)`);
      else if (/Fault>/i.test(r.text)) out.errors.push(`${label}: ${tag(r.text, "Text") || tag(r.text, "faultstring") || "SOAP Fault"}`);
      else out.errors.push(`${label}: HTTP ${r.status}`);
      return null;
    } catch (e) {
      out.errors.push(`${label}: ${e.name === "AbortError" ? "timeout" : e.message}`);
      return null;
    }
  };

  // 1) Info del equipo — valida conectividad/credenciales.
  const infoXml = await call(deviceUrl, B.deviceInfo, "GetDeviceInformation");
  if (infoXml == null && out.errors.some((e) => /timeout|ECONN|EHOSTUNREACH|ENOTFOUND|fetch/i.test(e))) {
    out.errors.unshift(`No se pudo conectar con ${h}:${p} por ONVIF. Revisa IP/puerto (a veces 8000) y que ONVIF esté habilitado.`);
    return out;
  }
  if (infoXml) out.device = parseDeviceInfo(infoXml);

  // 2) Servicios → endpoints de media/analytics.
  const servicesXml = await call(deviceUrl, B.services, "GetServices");
  const services = servicesXml ? parseServices(servicesXml) : {};
  const media2Url = services["http://www.onvif.org/ver20/media/wsdl"] || null;
  const media1Url = services["http://www.onvif.org/ver10/media/wsdl"] || null;
  const analyticsUrl = services["http://www.onvif.org/ver20/analytics/wsdl"]
    || services["http://www.onvif.org/ver20/analytics"] || null;
  const eventsUrl = services["http://www.onvif.org/ver10/events/wsdl"] || null;

  // 3) Perfiles (canales) + streams RTSP. Media2 primero, Media1 de respaldo.
  let profiles = [];
  if (media2Url) {
    const x = await call(media2Url, B.profiles2, "Media2 GetProfiles");
    if (x) profiles = parseProfiles(x);
  }
  let useMedia1 = false;
  if (!profiles.length) {
    const url1 = media1Url || deviceUrl.replace("/device_service", "/media_service");
    const x = await call(url1, B.profiles1, "Media GetProfiles");
    if (x) { profiles = parseProfiles(x); useMedia1 = true; if (!media1Url) services["__media1"] = url1; }
  }

  out.channels = profiles.map((pf, i) => ({
    id: pf.token, name: pf.name, ip: h,
    online: true, codec: pf.codec, resolution: pf.resolution,
  }));

  // 4) RTSP por perfil.
  const mediaUrl = useMedia1 ? (media1Url || services["__media1"]) : media2Url;
  for (const pf of profiles) {
    if (!mediaUrl) break;
    const body = useMedia1 ? B.streamUri1(pf.token) : B.streamUri2(pf.token);
    const x = await call(mediaUrl, body, `GetStreamUri(${pf.name})`);
    const uri = x ? parseStreamUri(x) : null;
    if (uri) out.streams.push({ id: pf.token, codec: pf.codec, resolution: pf.resolution, rtsp: uri });
  }

  // 5) Analíticas configuradas por perfil (best-effort).
  if (analyticsUrl) {
    const seen = new Set();
    for (const pf of profiles) {
      if (!pf.analyticsToken) continue;
      const x = await call(analyticsUrl, B.analyticsModules(pf.analyticsToken), `GetAnalyticsModules(${pf.name})`);
      for (const a of parseAnalyticsModules(x, pf.name)) {
        const key = `${a.type}|${a.channel}`;
        if (!seen.has(key)) { seen.add(key); out.analytics.push(a); }
      }
    }
  }
  // Respaldo: tipos de evento soportados (señal de capacidades del equipo).
  if (!out.analytics.length && eventsUrl) {
    const x = await call(eventsUrl, B.eventProps, "GetEventProperties");
    if (x) {
      const seen = new Set();
      for (const leaf of Object.keys(ANALYTIC_LABEL)) {
        if (new RegExp(`[:<]${leaf}\\b`).test(x) && !seen.has(leaf)) {
          seen.add(leaf);
          out.analytics.push({ type: leaf, label: ANALYTIC_LABEL[leaf], channel: null });
        }
      }
    }
  }

  return out;
}

export default { discover };
