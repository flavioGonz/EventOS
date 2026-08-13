// discovery/akuvox.js — descubrimiento de porteros/intercom Akuvox por su HTTP API.
//
// Akuvox NO expone ISAPI ni ONVIF: se habla por /api/{target}/{action} (JSON,
// `retcode:0` = OK), auth Basic o Digest, normalmente sobre HTTPS con cert
// self-signed. Por eso el "Detectando relés" fallaba: se sondeaba por ONVIF.
// Devuelve el MISMO shape que discovery/hikvision.js para que DeviceProbe lo
// consuma igual: { device, channels, streams, analytics, outputs, errors }.
//
// Verificado en campo (2026-08): Akuvox E16C V2.0, firmware 216.30.10.141,
// /api/system/info + /api/relay/status ({RelayA}) + /api/input/status ({InputA})
// por Basic sobre HTTPS:8082 (cert self-signed).
import https from "node:https";
import http from "node:http";
import crypto from "node:crypto";

const md5 = (s) => crypto.createHash("md5").update(s).digest("hex");

function parseAuthHeader(h) {
  const o = {};
  const re = /(\w+)=(?:"([^"]*)"|([^,\s]+))/g;
  let m;
  while ((m = re.exec(h))) o[m[1].toLowerCase()] = m[2] !== undefined ? m[2] : m[3];
  return o;
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
  let s = `Digest username="${user}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}"`;
  if (useQop) s += `, qop=${useQop}, nc=${nc}, cnonce="${cnonce}"`;
  if (opaque) s += `, opaque="${opaque}"`;
  return s;
}

// Request de bajo nivel — self-signed OK (rejectUnauthorized:false).
function rawReq({ host, port, secure, path, headers = {}, timeoutMs = 6000 }) {
  return new Promise((resolve, reject) => {
    const mod = secure ? https : http;
    const req = mod.request(
      { host, port, path, method: "GET", headers, rejectUnauthorized: false, timeout: timeoutMs },
      (res) => {
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (buf += c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: buf }));
      }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.end();
  });
}

// GET a la HTTP API con Basic; si el equipo pide Digest (401), reintenta digest.
async function apiGet(opt, path) {
  const basic = "Basic " + Buffer.from(`${opt.user}:${opt.pass}`).toString("base64");
  let res = await rawReq({ ...opt, path, headers: { Authorization: basic } });
  if (res.status === 401) {
    const wa = res.headers["www-authenticate"] || "";
    if (/digest/i.test(wa)) {
      const authz = digestAuth({ user: opt.user, pass: opt.pass, method: "GET", uri: path, auth: parseAuthHeader(wa) });
      res = await rawReq({ ...opt, path, headers: { Authorization: authz } });
    }
  }
  let json = null;
  try { json = JSON.parse(res.text); } catch { /* no-json */ }
  return { status: res.status, json };
}

export async function discover({ host, port, rtspPort, user, pass, https: secure = true }) {
  const base = {
    host: String(host || "").trim(),
    port: Number(port) || (secure ? 443 : 80),
    user: user || "",
    pass: pass || "",
    timeoutMs: 6000,
  };
  const out = { host: base.host, port: base.port, device: null, channels: [], streams: [], analytics: [], outputs: [], zones: [], subsystems: [], errors: [] };
  if (!base.host || !base.user) { out.errors.push("Faltan host o credenciales."); return out; }

  // 1) Conexión + identidad. Probamos el esquema indicado y, si la conexión
  //    falla (no 401/HTTP), el otro — así toleramos el flag https mal seteado.
  const schemes = secure ? [true, false] : [false, true];
  let opt = null;
  let info = null;
  for (const sc of schemes) {
    const o = { ...base, secure: sc };
    try {
      const r = await apiGet(o, "/api/system/info");
      opt = o;
      if (r.status === 200 && r.json && r.json.retcode === 0) { info = r.json; break; }
      if (r.status === 401) { out.errors.push("system/info: 401 (credenciales inválidas)"); break; }
      out.errors.push(`system/info (${sc ? "https" : "http"}): HTTP ${r.status}`);
    } catch (e) {
      out.errors.push(`conexión ${sc ? "https" : "http"}: ${e.message}`);
    }
  }
  if (!info) {
    out.errors.unshift(`No se pudo hablar la HTTP API de Akuvox en ${base.host}:${base.port}. Revisá IP/puerto, HTTP API habilitado y credenciales.`);
    return out;
  }
  const st = info.data?.Status || {};
  out.device = {
    name: st.Model || "Portero Akuvox",
    model: st.Model || null,
    deviceType: "intercom",
    firmware: st.FirmwareVersion || null,
    mac: st.MAC || null,
    serial: st.MAC || null,
  };

  // 2) Relés / salidas (lo que fallaba por ONVIF). num 1=RelayA, 2=RelayB, 3=RelayC.
  try {
    const r = await apiGet(opt, "/api/relay/status");
    if (r.status === 200 && r.json?.retcode === 0) {
      const d = r.json.data || {};
      out.outputs = Object.keys(d)
        .filter((k) => /^Relay/i.test(k))
        .map((k, i) => ({ id: i + 1, name: `Relé ${k.replace(/^Relay/i, "")}`, key: k }));
    }
  } catch { /* opcional */ }

  // 3) Entradas (informativo — el portero suele traer 1 input de contacto).
  try {
    const r = await apiGet(opt, "/api/input/status");
    if (r.status === 200 && r.json?.retcode === 0) {
      const n = Object.keys(r.json.data || {}).length;
      if (n) out.errors.push(`${n} entrada(s) detectada(s)`);
    }
  } catch { /* opcional */ }

  // 4) El portero tiene UNA cámara. Canal único + RTSP tentativo (perfil Akuvox).
  out.channels = [{ id: 1, name: out.device.name, ip: base.host, online: true }];
  const rp = Number(rtspPort) || 554;
  out.streams = [{ id: 101, codec: null, resolution: null, rtsp: `rtsp://${base.host}:${rp}/live/ch00_0` }];

  return out;
}

// health({host,port,user,pass,https}) - salud del portero para la pestana Salud:
// modelo, firmware, hardware, MAC, uptime, LAN y cuentas SIP (servidor + registro).
export async function health({ host, port, user, pass, https: secure = true }) {
  const base = { host: String(host || "").trim(), port: Number(port) || (secure ? 443 : 80), user: user || "", pass: pass || "", timeoutMs: 6000 };
  const out = { online: false, model: null, firmware: null, hardware: null, mac: null, uptime: null, uptimeSec: null, lan: null, sip: [] };
  if (!base.host || !base.user) return out;
  const schemes = secure ? [true, false] : [false, true];
  let info = null;
  for (const sc of schemes) {
    const o = { ...base, secure: sc };
    try {
      const r = await apiGet(o, "/api/system/info");
      if (r.status === 200 && r.json && r.json.retcode === 0) { info = r.json; break; }
      if (r.status === 401) break;
    } catch { /* prueba el otro esquema */ }
  }
  if (!info) return out;
  const d = info.data || {};
  const st = d.Status || {};
  out.online = true;
  out.model = st.Model || null;
  out.firmware = st.FirmwareVersion || null;
  out.hardware = st.HardwareVersion || null;
  out.mac = st.MAC || null;
  out.uptime = st.Uptime || null;
  if (typeof st.Uptime === "string" && st.Uptime.includes(":")) {
    const q = st.Uptime.split(":").map(Number);
    if (q.every(Number.isFinite)) out.uptimeSec = q.length === 3 ? q[0] * 3600 + q[1] * 60 + q[2] : (q.length === 2 ? q[0] * 60 + q[1] : q[0]);
  }
  const lan = d.Lan || {};
  if (lan.IPAddress) out.lan = { ip: lan.IPAddress, mask: lan.SubnetMask || null, gateway: lan.Gateway || null, dns: [lan.DNS1, lan.DNS2].filter(Boolean).join(", ") || null, link: String(lan.LinkStatus) === "1" };
  const stateOf = (v) => (String(v) === "2" ? "registered" : String(v) === "1" ? "registering" : "offline");
  for (const key of ["Account1", "Account2"]) {
    const a = d[key];
    if (a && (a.SipServer || a.UserName)) out.sip.push({ account: key.replace("Account", ""), user: a.UserName || null, server: a.SipServer || null, status: a.Status != null ? a.Status : null, registered: String(a.Status) === "2", state: stateOf(a.Status) });
  }
  return out;
}

// logs({host,port,user,pass,https}, limit) — registro nativo del portero:
// doorlog (aperturas con tarjeta/PIN/rostro/QR) + calllog (llamadas). El E16C
// ignora paginacion y devuelve TODO (~5MB); por eso se corta a `limit` recientes
// (vienen del mas nuevo al mas viejo) y el caller cachea el resultado.
export async function logs({ host, port, user, pass, https: secure = true }, limit = 120) {
  const base = { host: String(host || "").trim(), port: Number(port) || (secure ? 443 : 80), user: user || "", pass: pass || "", timeoutMs: 15000 };
  const out = [];
  if (!base.host || !base.user) return out;
  const schemes = secure ? [true, false] : [false, true];
  let opt = null;
  for (const sc of schemes) {
    const o = { ...base, secure: sc };
    try { const r = await apiGet(o, "/api/system/info"); if (r.status === 200 && r.json && r.json.retcode === 0) { opt = o; break; } if (r.status === 401) break; } catch { /* otro esquema */ }
  }
  if (!opt) return out;
  const items = (j) => (j && j.data && (j.data.item || j.data.Item)) || [];
  try {
    const r = await apiGet(opt, "/api/doorlog/get");
    for (const x of items(r.json).slice(0, limit)) {
      out.push({ ts: `${x.Date}T${x.Time}`, source: "device", kind: "door", title: x.Type || "Acceso", status: x.Status || null, relay: x.RelayID || null, user: x.Name || x.UserID || null, detail: [x.Name, x.Code ? `cod ${x.Code}` : null, x.RelayID ? `rele ${x.RelayID}` : null].filter(Boolean).join(" · ") });
    }
  } catch { /* opcional */ }
  try {
    const r = await apiGet(opt, "/api/calllog/get");
    for (const x of items(r.json).slice(0, limit)) {
      out.push({ ts: `${x.Date}T${x.Time}`, source: "device", kind: "call", title: x.Type || "Llamada", status: null, user: x.Name || null, detail: [x.Name, x.Num].filter(Boolean).join(" · ") });
    }
  } catch { /* opcional */ }
  return out;
}


// ── Usuarios cargados en el portero (SmartPlus user/get) ─────────────────────
// Lee TODO lo que el equipo tiene dentro por persona: nombre, tarjeta (CardCode),
// PIN privado (PrivatePIN), rostro (FaceUrl), grupo, tipo, teléfono, web relay.
// Verificado 2026-08-12 contra E16C (87 usuarios). Ojo: en este firmware el
// endpoint es `user/get` (minúscula); `User/get`, `rfkey/get` y `privatekey/get`
// devuelven "No handlers" — user/get unifica tarjeta+PIN+rostro por persona.
export async function users(opt) {
  const r = await apiGet(opt, "/api/user/get");
  const items = (r.json && r.json.data && Array.isArray(r.json.data.item)) ? r.json.data.item : [];
  return items.map((u) => ({
    userId: String(u.UserID || u.ID || ""),
    name: (u.Name || "").trim(),
    card: (u.CardCode || "").trim(),
    pin: (u.PrivatePIN || "").trim(),
    face: (u.FaceUrl || "").trim(),
    group: (u.Group || "").trim(),
    type: String(u.Type == null ? "" : u.Type),
    phone: (u.PhoneNumber || "").trim(),
    webRelay: (u.WebRelay || "").trim(),
  }));
}

// Descarga la imagen del rostro (FaceUrl) del equipo, con la misma auth (Basic→Digest).
// Devuelve { contentType, buffer } o null. Self-contained para poder pedir binario.
export async function faceImage(opt, faceUrl) {
  if (!faceUrl) return null;
  let path = faceUrl;
  try { if (/^https?:\/\//i.test(faceUrl)) { const u = new URL(faceUrl); path = u.pathname + (u.search || ""); } } catch { /* usar tal cual */ }
  const lib = opt.secure ? (await import("node:https")).default : (await import("node:http")).default;
  const doReq = (headers) => new Promise((resolve) => {
    const req = lib.request({ host: opt.host, port: opt.port, path, method: "GET", headers, rejectUnauthorized: false, timeout: 8000 }, (res) => {
      const ch = []; res.on("data", (c) => ch.push(c)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, buffer: Buffer.concat(ch) }));
    });
    req.on("error", () => resolve({ status: 0 })); req.on("timeout", () => req.destroy()); req.end();
  });
  const basic = "Basic " + Buffer.from(`${opt.user}:${opt.pass}`).toString("base64");
  let res = await doReq({ Authorization: basic });
  if (res.status === 401) {
    const wa = (res.headers && res.headers["www-authenticate"]) || "";
    if (/digest/i.test(wa)) res = await doReq({ Authorization: digestAuth({ user: opt.user, pass: opt.pass, method: "GET", uri: path, auth: parseAuthHeader(wa) }) });
  }
  if (res.status !== 200 || !res.buffer || res.buffer.length < 100) return null;
  return { contentType: (res.headers && res.headers["content-type"]) || "image/jpeg", buffer: res.buffer };
}

export default { discover, health, logs, users, faceImage };
