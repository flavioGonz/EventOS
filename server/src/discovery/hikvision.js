// discovery/hikvision.js — descubrimiento de equipos vía ISAPI de Hikvision.
// Sondea un NVR/cámara (con credenciales) y enumera: info del equipo, canales
// (cámaras del NVR), analíticas/eventos configurados y rutas de stream RTSP.
// Cliente HTTP con Digest auth (sin dependencias). Tolerante: nunca lanza hacia
// afuera; devuelve resultados parciales + lista de errores.
import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";

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

function parseStreams(xml, { host, rtspPort }) {
  return blocks(xml, "StreamingChannel").map((b) => {
    const id = tag(b, "id") || "";
    const codec = tag(b, "videoCodecType") || null;
    const w = tag(b, "videoResolutionWidth");
    const h = tag(b, "videoResolutionHeight");
    return {
      id,
      codec,
      resolution: w && h ? `${w}x${h}` : null,
      rtsp: id ? `rtsp://${host}:${rtspPort || 554}/Streaming/channels/${id}` : null,
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

// Salidas de relé (IO): cada <IOOutputPort> es una salida física (puerta/relé).
function parseOutputs(xml) {
  return blocks(xml, "IOOutputPort").map((b) => ({
    id: tag(b, "id") || null,
    name: tag(b, "ioPortDescription") || tag(b, "name") || null,
  })).filter((o) => o.id);
}

// ── Paneles de alarma AX (SecurityCP) ────────────────────────────────────────
// Los AX Pro/Hybrid responden JSON (?format=json). Parseo tolerante: aceptamos
// varias grafías de clave según firmware; nunca lanzamos. Sin panel real la rama
// simplemente devuelve listas vacías (degradación elegante).
function tryJson(text) { try { return JSON.parse(text); } catch { return null; } }
const asArray = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
// Desanida objetos tipo {ZoneList:[{Zone:{...}}]} → [{...}] probando envoltorios.
function unwrapList(root, listKeys, itemKeys) {
  if (!root) return [];
  let list = null;
  for (const k of listKeys) if (root[k] != null) { list = root[k]; break; }
  if (list == null && Array.isArray(root)) list = root;
  return asArray(list).map((el) => {
    for (const ik of itemKeys) if (el && el[ik] != null) return el[ik];
    return el;
  }).filter(Boolean);
}
function parseAxZones(text) {
  const j = tryJson(text); if (!j) return [];
  return unwrapList(j, ["ZoneList", "List", "zoneList"], ["Zone", "zone"]).map((z) => ({
    id: z.id ?? z.zoneID ?? z.seq ?? null,
    name: z.zoneName || z.name || z.detectorName || null,
    zoneType: z.zoneType || z.detectorType || z.type || null,
    subSystem: z.subSystemNo ?? z.subsystem ?? z.areaNo ?? null,
    status: z.status || z.zoneStatus || null,
  })).filter((z) => z.id != null || z.name);
}
function parseAxSubsys(text) {
  const j = tryJson(text); if (!j) return [];
  return unwrapList(j, ["SubSysList", "List", "subSysList"], ["SubSys", "subSys"]).map((s) => ({
    id: s.id ?? s.subSystemNo ?? null,
    name: s.name || s.subSystemName || null,
    armMode: s.arming || s.armMode || s.status || null,
  })).filter((s) => s.id != null || s.name);
}
function parseAxOutputs(text) {
  const j = tryJson(text); if (!j) return [];
  return unwrapList(j, ["OutputList", "List", "RelayList", "outputList"], ["Output", "output", "Relay", "relay"]).map((o) => ({
    id: o.id ?? o.outputNo ?? o.relayNo ?? null,
    name: o.name || o.outputName || o.relayName || null,
  })).filter((o) => o.id != null || o.name);
}

// ── Estado en vivo del panel AX (salud + zonas + relés) ──────────────────────
// Lo que el operador necesita ver de un panel de alarma: si tiene corriente y
// batería, si la red está viva, si algún módulo/disco falla, qué zonas están
// ABIERTAS (contacto magnético) o en alarma/sabotaje, y el estado real de cada
// relé. Todo por SecurityCP status (?format=json). Tolerante: cada sonda es
// independiente y su fallo no tumba al resto — un firmware que no expone una
// rama simplemente deja ese campo vacío.
const boolish = (v) => {
  if (v === true || v === false) return v;
  const s = String(v ?? "").toLowerCase().trim();
  if (["true", "open", "opened", "on", "yes", "1", "trigger", "active", "alarm"].includes(s)) return true;
  if (["false", "close", "closed", "off", "no", "0", "normal", "inactive"].includes(s)) return false;
  return null;
};
// Extrae el primer valor definido de una lista de claves candidatas (grafías por firmware).
const pick = (o, ...keys) => { for (const k of keys) if (o && o[k] != null) return o[k]; return null; };

function parseAxBattery(text) {
  const j = tryJson(text); if (!j) return null;
  const list = unwrapList(j, ["BatteryList", "List"], ["Battery", "battery"]);
  const b = list[0] || (j.Battery || j.battery || j.BatteryStatus || j);
  if (!b || typeof b !== "object") return null;
  const charging = boolish(pick(b, "charge", "chargeStatus", "charging", "chargeTestResult"));
  const pct = pick(b, "batteryPercent", "percent", "electricQuantity", "capacity", "chargeValue");
  const volt = pick(b, "voltage", "batteryVoltage");
  const st = pick(b, "batteryStatus", "status", "batteryFault");
  const lowFlag = boolish(pick(b, "lowBattery", "batteryLow"));
  return {
    percent: pct != null ? Number(pct) : null,
    voltage: volt != null ? Number(volt) : null,
    charging,
    low: lowFlag != null ? lowFlag : (pct != null ? Number(pct) <= 20 : null),
    status: st != null ? String(st) : null,
  };
}
function parseAxComm(text) {
  const j = tryJson(text); if (!j) return null;
  const list = unwrapList(j, ["CommunicationList", "List"], ["Communication", "communication"]);
  const c = list[0] || j.Communication || j.communication || j;
  if (!c || typeof c !== "object") return null;
  const wired = pick(c, "wiredNetworkStatus", "ethernetStatus", "lanStatus", "netStatus");
  const wifi = pick(c, "wifiStatus", "wlanStatus");
  const mobile = pick(c, "GPRSStatus", "gprsStatus", "cellularStatus", "mobileStatus", "3G4GStatus");
  const online = boolish(wired) || boolish(wifi) || boolish(mobile);
  const netType = boolish(wired) ? "ethernet" : boolish(wifi) ? "wifi" : boolish(mobile) ? "móvil" : null;
  return {
    online: online === null ? null : online,
    type: netType,
    wired: wired != null ? String(wired) : null,
    wifi: wifi != null ? String(wifi) : null,
    mobile: mobile != null ? String(mobile) : null,
  };
}
// Estado extendido: alimentación AC, sabotaje del gabinete, salud de disco/módulos.
function parseAxHost(text) {
  const j = tryJson(text); if (!j) return null;
  const h = j.CardReaderStatus || j.HostStatus || j.hostStatus || j.status || j;
  if (!h || typeof h !== "object") return {};
  const ac = boolish(pick(h, "acPower", "mainPower", "ACStatus", "acStatus", "powerStatus"));
  const tamper = boolish(pick(h, "tamperEvident", "tamper", "caseOpen"));
  const battFault = boolish(pick(h, "batteryFault", "batteryStatus"));
  return {
    ac: ac,                      // corriente de red presente
    tamper: tamper,              // sabotaje del gabinete
    batteryFault: battFault,     // batería en falla
  };
}
// Zona con TODO lo que le importa al operador: si está abierta (contacto
// magnético), en alarma, saboteada, anulada (bypass), su batería y señal RF.
function parseAxZonesStatus(text) {
  const j = tryJson(text); if (!j) return [];
  return unwrapList(j, ["ZoneList", "List", "zoneList"], ["Zone", "zone"]).map((z) => ({
    id: pick(z, "id", "zoneID", "seq"),
    name: pick(z, "zoneName", "name", "detectorName"),
    online: boolish(pick(z, "status", "zoneStatus", "onlineStatus")),
    open: boolish(pick(z, "magnetOpenStatus", "magnetOpen", "doorOpen", "openStatus")),
    alarm: boolish(pick(z, "alarm", "alarmStatus")),
    tamper: boolish(pick(z, "tamperEvident", "tamper")),
    bypass: boolish(pick(z, "bypassed", "bypass", "shielded")),
    armed: boolish(pick(z, "armed", "armStatus")),
    battery: (() => { const v = pick(z, "battery", "batteryVoltage", "chargeValue"); return v != null ? Number(v) : null; })(),
    lowBattery: boolish(pick(z, "lowBatteryLimit", "batteryLow", "lowBattery")),
    signal: (() => { const v = pick(z, "signal", "signalStrength", "RSSI"); return v != null ? Number(v) : null; })(),
    type: pick(z, "zoneType", "detectorType", "type"),
  })).filter((z) => z.id != null || z.name);
}
function parseAxOutputsStatus(text) {
  const j = tryJson(text); if (!j) return [];
  return unwrapList(j, ["OutputList", "List", "OutputsList", "RelayList"], ["Output", "output", "Relay", "relay"]).map((o) => ({
    id: pick(o, "id", "outputNo", "relayNo"),
    name: pick(o, "name", "outputName", "relayName"),
    on: boolish(pick(o, "switch", "status", "outputStatus", "state")),
  })).filter((o) => o.id != null || o.name);
}

/**
 * Estado en vivo de un panel AX. Devuelve { ok, host, subsystems, zones,
 * outputs, errors }. NUNCA lanza: cada sonda captura su error y sigue. `ok` es
 * true si al menos una rama respondió (el equipo está vivo por SecurityCP).
 */
export async function axStatus({ host, port, user, pass, https = false, timeoutMs = 5000 }) {
  const opt = { host: String(host || "").trim(), port: Number(port) || (https ? 443 : 80), https: !!https, user, pass, timeoutMs };
  const out = { ok: false, host: {}, subsystems: [], zones: [], outputs: [], errors: [] };
  if (!opt.host || !user) { out.errors.push("Faltan host o credenciales."); return out; }

  const probe = async (path, onOk) => {
    try {
      const r = await isapiGet({ ...opt, path });
      if (r.status === 200) { onOk(r.text); out.ok = true; }
      else if (r.status === 401) out.errors.push(`${path}: 401 (credenciales inválidas)`);
      else if (r.status !== 404) out.errors.push(`${path}: HTTP ${r.status}`);
    } catch (e) {
      out.errors.push(`${path}: ${e.name === "AbortError" ? "timeout" : e.message}`);
    }
  };

  // Salud del host: batería, red y estado extendido (AC/sabotaje/disco).
  await probe("/ISAPI/SecurityCP/status/battery?format=json", (t) => { const b = parseAxBattery(t); if (b) out.host.battery = b; });
  await probe("/ISAPI/SecurityCP/status/communication?format=json", (t) => { const c = parseAxComm(t); if (c) out.host.network = c; });
  await probe("/ISAPI/SecurityCP/status/exDevStatus?format=json", (t) => { const h = parseAxHost(t); if (h) Object.assign(out.host, h); });
  // Subsistemas (particiones): estado de armado. Preferimos status; fallback config.
  await probe("/ISAPI/SecurityCP/status/subSys?format=json", (t) => { out.subsystems = parseAxSubsys(t); });
  if (!out.subsystems.length) await probe("/ISAPI/SecurityCP/status/subSystems?format=json", (t) => { out.subsystems = parseAxSubsys(t); });
  // Zonas: apertura de puerta/ventana, alarma, sabotaje, batería.
  await probe("/ISAPI/SecurityCP/status/zones?format=json", (t) => { out.zones = parseAxZonesStatus(t); });
  // Relés/salidas: estado real (on/off) para el toggle de la UI.
  await probe("/ISAPI/SecurityCP/status/outputs?format=json", (t) => { out.outputs = parseAxOutputsStatus(t); });

  return out;
}

// ── API ──────────────────────────────────────────────────────────────────────
export async function discover({ host, port, rtspPort, user, pass, https = false, type = "" }) {
  const opt = { host: String(host || "").trim(), port: Number(port) || (https ? 443 : 80), rtspPort: Number(rtspPort) || 554, https: !!https, user, pass };
  const out = { host: opt.host, port: opt.port, device: null, channels: [], streams: [], analytics: [], outputs: [], zones: [], subsystems: [], errors: [] };
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

  // ¿Es un panel de alarma AX? Por el tipo declarado en la ficha o por el
  // deviceType que reporta el equipo (SecurityCPModule / "alarm host").
  const dtype = (out.device?.deviceType || "").toLowerCase();
  const looksAx = /alarm|securitycp|securitypanel/.test(dtype);
  const wantAlarm = /alarm|panel/i.test(type) || looksAx;

  if (wantAlarm) {
    // Panel AX: enumerar zonas, subsistemas (particiones) y salidas por SecurityCP.
    // JSON tolerante; si el firmware usa otra ruta, cae a vacío con un aviso.
    await probe("/ISAPI/SecurityCP/Configuration/zones?format=json", (t) => { out.zones = parseAxZones(t); });
    if (!out.zones.length) await probe("/ISAPI/SecurityCP/status/zones?format=json", (t) => { out.zones = parseAxZones(t); });
    await probe("/ISAPI/SecurityCP/Configuration/subSys?format=json", (t) => { out.subsystems = parseAxSubsys(t); });
    await probe("/ISAPI/SecurityCP/Configuration/outputCfg?format=json", (t) => { out.outputs = parseAxOutputs(t); });
    if (!out.outputs.length) await probe("/ISAPI/SecurityCP/status/outputs?format=json", (t) => { out.outputs = parseAxOutputs(t); });
    // Salidas IO físicas del propio panel (si expone además IO clásico).
    if (!out.outputs.length) await probe("/ISAPI/System/IO/outputs", (t) => { out.outputs = parseOutputs(t); });
  } else {
    // Cámara / NVR / portero: canales, streams, analíticas y relés IO.
    await probe("/ISAPI/ContentMgmt/InputProxy/channels", (t) => { out.channels = parseProxyChannels(t); });
    if (!out.channels.length) {
      await probe("/ISAPI/System/Video/inputs/channels", (t) => { out.channels = parseVideoChannels(t); });
    }
    await probe("/ISAPI/Streaming/channels", (t) => { out.streams = parseStreams(t, opt); });
    await probe("/ISAPI/Event/triggers", (t) => { out.analytics = parseTriggers(t); });
    await probe("/ISAPI/System/IO/outputs", (t) => { out.outputs = parseOutputs(t); });
  }

  return out;
}


// ── Registro de eventos del equipo (logSearch) ───────────────────────────────
// Descubierto en campo (DS-7616NI-Q2, 2026-08-12): POST /ISAPI/ContentMgmt/logSearch
// con CMSearchDescription + <metaId>log.hikvision.com</metaId>  (¡'metaId' con 'd'
// minúscula! con mayúscula da badXmlContent). El handshake digest debe SONDEAR SIN
// cuerpo primero. searchID = GUID; el campo va mal escrito a propósito:
// <searchResultPostion>. Respuesta: <searchMatchItem><logDescriptor> con metaId
// (.../Clase/tipo/canal), StartDateTime, localID (Dn=canal), userName, ipAddress,
// additionInformation.
const HIK_KIND = { Alarm: "alarm", Exception: "exception", Operation: "operation", Infomation: "system", Information: "system" };
const HIK_LABEL = {
  motionStart: "Inicio de movimiento", motionStop: "Fin de movimiento",
  runStatusInfo: "Estado de grabación", timing: "Sincronización horaria",
  remoteCfgPara: "Config remota", localCfgPara: "Config local",
  remoteGetStatus: "Consulta de estado", remoteGetPara: "Consulta de config",
  localLogin: "Inicio de sesión (local)", remoteLogin: "Inicio de sesión (remoto)",
  localLogout: "Cierre de sesión (local)", remoteLogout: "Cierre de sesión (remoto)",
  localOperateFile: "Operación de archivo", remotePlayByTime: "Reproducción remota",
  remoteExport: "Exportación remota", videoLoss: "Pérdida de video",
  hddError: "Error de disco", netBroken: "Red desconectada",
  illegalAccess: "Acceso ilegal", ipConflict: "Conflicto de IP",
  startup: "Encendido", shutdown: "Apagado", reboot: "Reinicio",
  lineDetection: "Cruce de línea", fieldDetection: "Intrusión",
  faceContrast: "Comparación facial", vehicleDetection: "Detección de vehículo",
};

function _ltag(s, tag) { const m = s.match(new RegExp("<" + tag + ">([^<]*)</" + tag + ">")); return m ? m[1].trim() : ""; }

function _rawReq(lib, opts, body) {
  return new Promise((resolve, reject) => {
    const r = lib.request(opts, (res) => { let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: b })); });
    r.on("error", reject);
    r.on("timeout", () => r.destroy(new Error("timeout")));
    if (body) r.write(body);
    r.end();
  });
}

export async function logs(opt, limit = 200) {
  const { host, port = 80, user, pass, https: useHttps = false, channel = null, startMs, endMs, all = false } = opt || {};
  if (!host || !user) return [];
  const lib = useHttps ? https : http;
  const uri = "/ISAPI/ContentMgmt/logSearch";
  const end = endMs ? new Date(endMs) : new Date();
  const start = startMs ? new Date(startMs) : new Date(end.getTime() - 7 * 24 * 3600 * 1000);
  const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
  const base = { host, port, timeout: 12000, rejectUnauthorized: false };
  const startISO = iso(start), endISO = iso(new Date(end.getTime() + 60000));
  const probe = await _rawReq(lib, { ...base, path: "/ISAPI/System/time", method: "GET" });
  const wa = probe.headers["www-authenticate"] || "";
  if (!/digest/i.test(wa)) return [];
  const ch = parseAuthHeader(wa);
  // El log del equipo viene AGRUPADO por clase (Alarm/Exception/Operation/Infomation)
  // y dentro de cada clase, ASCENDENTE por tiempo. La motion domina y es ruido para
  // una bitácora, y las detecciones reales ya llegan por alertStream (eventos EventOS).
  // Acá traemos lo que EventOS NO tiene: Excepciones (salud: disco/red/pérdida video)
  // y Operaciones humanas (login/config/playback/export/reboot). Cada clase es
  // consultable por separado con <metaId>, y como es time-ascending por clase, la cola
  // (posición final) = lo más reciente.
  const fetchClass = async (metaId, pos, max) => {
    const body = `<CMSearchDescription><searchID>${crypto.randomUUID()}</searchID><metaId>${metaId}</metaId><timeSpanList><timeSpan><startTime>${startISO}</startTime><endTime>${endISO}</endTime></timeSpan></timeSpanList><maxResults>${max}</maxResults><searchResultPostion>${pos}</searchResultPostion></CMSearchDescription>`;
    const auth = digestAuth({ user, pass, method: "POST", uri, auth: ch });
    try { return await _rawReq(lib, { ...base, path: uri, method: "POST", headers: { Authorization: auth, "Content-Type": "application/xml", "Content-Length": Buffer.byteLength(body) } }, body); }
    catch { return null; }
  };
  const itemsOf = (r) => (r && r.status === 200 ? (r.text.match(/<searchMatchItem>[\s\S]*?<\/searchMatchItem>/g) || []) : []);
  // Todas las de una clase poco poblada (varias páginas hasta agotar).
  const allItems = async (metaId, capPages) => {
    const acc = []; let pos = 0;
    for (let p = 0; p < capPages; p++) {
      const r = await fetchClass(metaId, pos, 100);
      const its = itemsOf(r);
      if (!its.length) break;
      acc.push(...its); pos += its.length;
      if (!/MORE/i.test((r.text.match(/<responseStatusStrg>([^<]*)/) || [])[1] || "")) break;
    }
    return acc;
  };
  // Cola (más reciente) de una clase muy poblada, vía sondeo exponencial+binario.
  const tailItems = async (metaId, want) => {
    const has = async (pos) => { const r = await fetchClass(metaId, pos, 1); return itemsOf(r).length > 0; };
    let probes = 0;
    if (!(await has(0))) return [];
    probes++;
    let lo = 0, hi = 256;
    while (probes < 14) { if (await has(hi)) { probes++; lo = hi; hi *= 2; if (hi > 131072) break; } else { probes++; break; } }
    while (hi - lo > want && probes < 20) { const mid = Math.floor((lo + hi) / 2); if (await has(mid)) lo = mid; else hi = mid; probes++; }
    return itemsOf(await fetchClass(metaId, Math.max(0, lo), want + 40));
  };
  // Traemos TODAS las clases del registro del equipo:
  //  · Exception / Infomation → poco pobladas: varias páginas hasta agotar.
  //  · Operation / Alarm → muy pobladas (config humana / motion·línea·intrusión·
  //    armado): la COLA (posición final) = lo más reciente.
  // La cámara loguea sus detecciones en Alarm y la central Hik AX su armado/zonas
  // también en Alarm; por eso antes “no aparecía nada” en cámaras y alarmas.
  // Las 5 clases son independientes → las pedimos EN PARALELO. El tiempo de pared
  // pasa de la suma de todas a la más lenta (Alarm), que es la gran mejora de
  // rendimiento del tab Logs. Cada request usa su propio cnonce, así que reusar el
  // mismo nonce en paralelo es seguro (igual que ya se hacía en secuencia).
  const classFetches = await Promise.all([
    allItems("log.hikvision.com/Exception", 3),
    allItems("log.hikvision.com/Infomation", 2),
    allItems("log.hikvision.com/Information", 1),
    tailItems("log.hikvision.com/Operation", limit * 2),
    tailItems("log.hikvision.com/Alarm", limit * 2),
  ]);
  const raw = [].concat(...classFetches);
  const OP_KEEP = /login|logout|reboot|shutdown|startup|upgrade|format|export|playBy|manualRec|remoteArm|remoteDisarm|resetPass|addUser|delUser|modifyUser|localCfg|restore|factory/i;
  const chWant = channel != null && channel !== "" ? String(channel).replace(/\D/g, "") : null;
  const out = [];
  const seen = new Set();
  for (const it of raw) {
    const meta = _ltag(it, "metaId");
    const parts = meta.split("/");
    const cls = parts[1] || "";
    const typ = parts[2] || "";
    if (!all && cls === "Operation" && !OP_KEEP.test(typ)) continue; // sin `all`: descartar polling
    const ts = _ltag(it, "StartDateTime") || _ltag(it, "startDateTime");
    if (!ts) continue;
    const localId = _ltag(it, "localID") || _ltag(it, "localId");
    const chNum = (localId.match(/\d+/) || [])[0] || parts[3] || "";
    if (chWant && chNum && chNum !== chWant) continue;
    const userName = _ltag(it, "userName");
    const ip = _ltag(it, "ipAddress");
    let addl = _ltag(it, "additionInformation").replace(/\s+/g, " ").trim();
    // El additionInformation de excepciones trae "N.º de canal: Dn · IP · Nombre de
    // cámara: X"; nos quedamos con el nombre de la cámara si viene (lo demás ya está).
    const camName = (addl.match(/[Nn]ombre de c[aá]mara:?\s*([^·]+)/) || [])[1];
    if (camName) addl = camName.trim();
    else if (/N\.?.?\s*de canal|Direcci[oó]n IP/i.test(addl)) addl = "";
    const kind = HIK_KIND[cls] || "event";
    const key = ts + "|" + typ + "|" + chNum + "|" + userName;
    if (seen.has(key)) continue;
    seen.add(key);
    const detail = [
      chNum ? `Canal ${chNum}` : null,
      userName ? `usuario ${userName}` : null,
      ip && ip !== "::" && ip !== "0.0.0.0" ? ip : null,
      addl ? (addl.length > 70 ? addl.slice(0, 70) + "…" : addl) : null,
    ].filter(Boolean).join(" · ");
    out.push({ ts, source: "device", kind, title: HIK_LABEL[typ] || typ || cls, status: null, detail });
  }
  out.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
  return out.slice(0, limit);
}

export default { discover, logs, axStatus };
