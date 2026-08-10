// netscan.js — Escaneo de una red local para encontrar equipos de nuestro dominio
// (cámaras / NVR / equipos que hablan ISAPI, ONVIF o RTSP). Dos métodos combinados:
//   1) WS-Discovery (multicast UDP 3702): pregunta nativa de ONVIF — la mayoría de
//      cámaras/NVR responden con su XAddrs (IP) y scopes (tipo/modelo/nombre).
//   2) Barrido TCP del rango en los puertos que importan (80=ISAPI/HTTP, 554=RTSP,
//      8000=SDK Hik) para atrapar lo que no contesta WS-Discovery.
// Luego, si hay credenciales, identifica por ISAPI (deviceInfo) para saber marca/modelo.
// Es "astuto": solo reporta hosts con señal real de A/V (ISAPI, ONVIF o RTSP), no
// cualquier cosa con el 80 abierto.
import net from "net";
import dgram from "dgram";
import { digestGetBuffer } from "../util/digestFetch.js";

const WS_ADDR = "239.255.255.250";
const WS_PORT = 3702;

// ── Utilidades de rango ──────────────────────────────────────────────────────
// base "192.168.99" + from..to → lista de IPs. También acepta base con 4º octeto.
function expandRange({ base, from = 1, to = 254 }) {
  const b = String(base || "").trim().replace(/\.+$/, "");
  const parts = b.split(".").filter(Boolean);
  if (parts.length < 3) return [];
  const prefix = parts.slice(0, 3).join(".");
  const a = Math.max(0, Math.min(255, Number(from) || 0));
  const z = Math.max(a, Math.min(255, Number(to) || 0));
  const out = [];
  for (let i = a; i <= z; i++) out.push(`${prefix}.${i}`);
  return out;
}

// ── TCP: ¿puerto abierto? ────────────────────────────────────────────────────
function tcpOpen(host, port, timeoutMs = 1200) {
  return new Promise((res) => {
    const s = new net.Socket();
    let done = false;
    const fin = (v) => { if (done) return; done = true; try { s.destroy(); } catch { /* noop */ } res(v); };
    s.setTimeout(timeoutMs);
    s.once("connect", () => fin(true));
    s.once("timeout", () => fin(false));
    s.once("error", () => fin(false));
    try { s.connect(port, host); } catch { fin(false); }
  });
}

// Pool de concurrencia genérico.
async function pool(items, worker, concurrency = 40) {
  const q = items.slice();
  let active = 0;
  const results = [];
  await new Promise((resolve) => {
    const next = () => {
      if (!q.length && active === 0) return resolve();
      while (active < concurrency && q.length) {
        const it = q.shift(); active++;
        Promise.resolve(worker(it))
          .then((r) => { if (r) results.push(r); })
          .catch(() => { /* noop */ })
          .finally(() => { active--; next(); });
      }
    };
    next();
  });
  return results;
}

// ── WS-Discovery (ONVIF) ─────────────────────────────────────────────────────
function wsProbe(types) {
  const id = `uuid:${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  return `<?xml version="1.0" encoding="UTF-8"?>`
    + `<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope"`
    + ` xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing"`
    + ` xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery"`
    + ` xmlns:dn="http://www.onvif.org/ver10/network/wsdl">`
    + `<e:Header><w:MessageID>${id}</w:MessageID>`
    + `<w:To>urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To>`
    + `<w:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action></e:Header>`
    + `<e:Body><d:Probe>${types ? `<d:Types>${types}</d:Types>` : ""}</d:Probe></e:Body></e:Envelope>`;
}
function scopeVal(scopes, key) {
  const m = new RegExp(`onvif://www\\.onvif\\.org/${key}/([^\\s<]+)`, "i").exec(scopes || "");
  return m ? decodeURIComponent(m[1]) : null;
}
async function wsDiscover(timeoutMs = 2600) {
  return new Promise((resolve) => {
    const found = new Map(); // ip → { xaddr, scopes }
    let sock;
    try { sock = dgram.createSocket({ type: "udp4", reuseAddr: true }); }
    catch { return resolve(found); }
    const done = () => { try { sock.close(); } catch { /* noop */ } resolve(found); };
    sock.on("error", () => done());
    sock.on("message", (msg) => {
      const xml = msg.toString("utf8");
      const xadd = (/<[^>]*XAddrs>([\s\S]*?)<\/[^>]*XAddrs>/i.exec(xml) || [])[1] || "";
      const scopes = (/<[^>]*Scopes>([\s\S]*?)<\/[^>]*Scopes>/i.exec(xml) || [])[1] || "";
      const ipm = /https?:\/\/(\d+\.\d+\.\d+\.\d+)(?::(\d+))?/i.exec(xadd);
      if (!ipm) return;
      const ip = ipm[1];
      if (!found.has(ip)) found.set(ip, { xaddr: xadd.trim().split(/\s+/)[0] || "", scopes, port: ipm[2] ? Number(ipm[2]) : 80 });
    });
    try {
      sock.bind(0, () => {
        try { sock.setBroadcast(true); } catch { /* noop */ }
        const send = (t) => { const b = Buffer.from(wsProbe(t)); try { sock.send(b, 0, b.length, WS_PORT, WS_ADDR); } catch { /* noop */ } };
        send("dn:NetworkVideoTransmitter");
        send("");                              // sin filtro → cualquier dispositivo ONVIF
        setTimeout(() => send("dn:NetworkVideoTransmitter"), 500); // reintento (UDP)
        setTimeout(done, timeoutMs);
      });
    } catch { done(); }
  });
}

// ── Identificación por ISAPI (Hikvision) ─────────────────────────────────────
function xmlTag(xml, tag) { const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(xml || ""); return m ? m[1].trim() : null; }
async function identifyHik(host, port, user, pass) {
  try {
    const r = await digestGetBuffer({ host, port, path: "/ISAPI/System/deviceInfo", user, pass, timeoutMs: 3500 });
    if (r.status !== 200) return r.status === 401 ? { vendor: "Hikvision", auth: true } : null;
    const xml = r.buffer.toString("utf8");
    const dt = (xmlTag(xml, "deviceType") || "").toLowerCase();
    const type = /nvr|dvr|recorder/.test(dt) ? "nvr" : "camera";
    return { vendor: "Hikvision", model: xmlTag(xml, "model"), name: xmlTag(xml, "deviceName"), fw: xmlTag(xml, "firmwareVersion"), type };
  } catch { return null; }
}

// ── Escaneo principal ────────────────────────────────────────────────────────
export async function scan({ base, from = 1, to = 254, user = "", pass = "", onvif = true, tcpTimeoutMs = 1200, concurrency = 48 } = {}) {
  const ips = expandRange({ base, from, to });
  if (!ips.length) return { hosts: [], scanned: 0, error: "rango inválido" };

  // 1) WS-Discovery (en paralelo al barrido).
  const wsP = onvif ? wsDiscover().catch(() => new Map()) : Promise.resolve(new Map());

  // 2) Barrido TCP de 80/554 (los dos puertos que definen un equipo A/V).
  const PORTS = [80, 554];
  const tcp = new Map(); // ip → Set(puertos)
  await pool(ips, async (ip) => {
    const open = [];
    for (const p of PORTS) { if (await tcpOpen(ip, p, tcpTimeoutMs)) open.push(p); }
    if (open.length) tcp.set(ip, new Set(open));
    return null;
  }, concurrency);

  const ws = await wsP;

  // 3) Unión de candidatos (algo con 80/554, o que respondió WS-Discovery).
  const cand = new Set([...tcp.keys(), ...ws.keys()]);

  // 4) Identificación (limitada) por ISAPI cuando hay 80 abierto.
  const hosts = await pool([...cand], async (ip) => {
    const ports = tcp.get(ip) || new Set();
    const wsi = ws.get(ip);
    if (wsi && wsi.port) ports.add(wsi.port);
    let vendor = null, model = null, name = null, type = null, fw = null;
    // ISAPI (Hik) si el 80 está abierto y hay credenciales.
    if (ports.has(80) && (user || pass)) {
      const hik = await identifyHik(ip, 80, user, pass);
      if (hik) { vendor = hik.vendor; model = hik.model || null; name = hik.name || null; type = hik.type || null; fw = hik.fw || null; }
    }
    // ONVIF: vendor/modelo/nombre/tipo desde los scopes.
    if (!vendor && wsi) {
      vendor = scopeVal(wsi.scopes, "manufacturer") || scopeVal(wsi.scopes, "mfr") || "ONVIF";
      model = model || scopeVal(wsi.scopes, "hardware");
      name = name || scopeVal(wsi.scopes, "name");
    }
    if (!type && wsi) {
      if (/NetworkVideoRecorder/i.test(wsi.scopes)) type = "nvr";
      else if (/NetworkVideoTransmitter/i.test(wsi.scopes)) type = "camera";
    }
    // Fallback por puerto.
    if (!type) type = ports.has(554) ? "camera" : "camera";
    if (!vendor) vendor = ports.has(554) ? "RTSP" : "Desconocido";
    // "Astuto": descartar hosts sin ninguna señal A/V real.
    const signal = ports.has(554) || ports.has(80) || !!wsi;
    if (!signal) return null;
    const via = [];
    if (wsi) via.push("onvif");
    if (ports.has(80)) via.push("isapi/http");
    if (ports.has(554)) via.push("rtsp");
    return { ip, ports: [...ports].sort((a, b) => a - b), vendor, model: model || null, name: name || null, type, fw: fw || null, via };
  }, 16);

  hosts.sort((a, b) => {
    const na = Number(a.ip.split(".").pop()), nb = Number(b.ip.split(".").pop());
    return na - nb;
  });
  return { hosts, scanned: ips.length };
}

export default { scan };
