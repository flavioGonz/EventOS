// panels.js — recepción de eventos de paneles de alarma (AX) y controladoras
// de acceso (DS-K), por los DOS transportes.
//
// POR QUE DOS. No es indecisión: un ARC multi-sitio necesita los dos.
//
//   alertStream (pull)  EventOS abre una conexión HTTP persistente HACIA el
//                       equipo. Requiere alcanzarlo (LAN o VPN). Es lo que ya
//                       hacemos con los NVR de Cesimco y da latencia mínima.
//
//   httpHosts (push)    El equipo POSTea a /api/ingest/access. La conexión sale
//                       DEL equipo, así que atraviesa el NAT de un sitio de
//                       cliente sin abrir un solo puerto ahí. Es el único que
//                       escala a sitios que no controlamos.
//
// Cada dispositivo declara el suyo en `transport`: "alertstream" | "http" |
// "both". Sin declararlo se asume `alertstream` sólo si tiene credenciales
// ISAPI, que es como se comportaba EventOS hasta ahora.
//
// ⚠️ Este módulo NO importa doors.js. Recibir un evento nunca puede terminar en
// abrir una puerta: son dos caminos de código separados a propósito.

import http from "node:http";
import https from "node:https";
import { list as listConfig } from "../config/store.js";
import { ingestRaw } from "../dispatch/pipeline.js";
import { digestGetBuffer, digestRequest } from "../util/digestFetch.js";
import crypto from "node:crypto";

// Digest auth para el alertStream de paneles Hik AX: exigen Digest, no Basic.
const _md5 = (s) => crypto.createHash("md5").update(s).digest("hex");
function _parseAuth(header) {
  const out = {};
  const re = /(\w+)=(?:"([^"]*)"|([^,\s]+))/g;
  let m;
  while ((m = re.exec(header))) out[m[1].toLowerCase()] = m[2] !== undefined ? m[2] : m[3];
  return out;
}
function _digestAuth({ user, pass, method, uri, auth }) {
  const { realm = "", nonce = "", qop, opaque } = auth;
  const nc = "00000001";
  const cnonce = crypto.randomBytes(8).toString("hex");
  const ha1 = _md5(`${user}:${realm}:${pass}`);
  const ha2 = _md5(`${method}:${uri}`);
  const useQop = qop ? (qop.split(",")[0] || "auth").trim() : null;
  const response = useQop
    ? _md5(`${ha1}:${nonce}:${nc}:${cnonce}:${useQop}:${ha2}`)
    : _md5(`${ha1}:${nonce}:${ha2}`);
  let h = `Digest username="${user}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}"`;
  if (useQop) h += `, qop=${useQop}, nc=${nc}, cnonce="${cnonce}"`;
  if (opaque) h += `, opaque="${opaque}"`;
  return h;
}

const RECONNECT_MS = 10_000;
const DEDUP_MS = Number(process.env.EVENTOS_PANEL_DEDUP_MS || 5_000);
const log = {
  info: (m) => console.log(`[panels] ${m}`),
  error: (m) => console.error(`[panels] ${m}`),
};

// ── Qué paneles hay que escuchar ────────────────────────────────────────────
export function panelTargets() {
  let devices = [];
  try { devices = listConfig("devices"); } catch { /* store no listo */ }
  const out = [];
  for (const d of devices) {
    const t = String(d.type || "").toLowerCase();
    const isPanel = ["alarm", "panel", "ax", "access", "acceso", "dsk"].some((k) => t.includes(k)) ||
                    ["ax", "dsk"].includes(String(d.relayKind || "").toLowerCase());
    if (!isPanel) continue;
    const transport = String(d.transport || (d.username && d.ip ? "alertstream" : "http")).toLowerCase();
    out.push({
      id: d.id, name: d.name || d.id, host: d.ip, port: Number(d.isapiPort) || 80,
      https: !!d.isapiHttps, user: d.username, pass: d.password || "",
      siteId: d.siteId || null, transport,
    });
  }
  return out;
}

// ── Transporte 1: alertStream ───────────────────────────────────────────────
// Mismo patrón que ingest/alertStream.js para los NVR: conexión persistente,
// digest, y reconexión con backoff. La diferencia es qué se hace con el cuerpo.
const lastEmit = new Map();

function dedup(key) {
  const now = Date.now();
  if (now - (lastEmit.get(key) || 0) < DEDUP_MS) return true;
  lastEmit.set(key, now);
  return false;
}

/** Parte el stream multipart en alertas sueltas. */
export function splitAlerts(chunkText) {
  return [...chunkText.matchAll(
    /<(?:[\w.-]+:)?EventNotificationAlert[\s\S]*?<\/(?:[\w.-]+:)?EventNotificationAlert\s*>/gi
  )].map((m) => m[0]);
}

async function handleAlert(panel, payload) {
  // Clave de dedup: el equipo repite la misma alerta mientras la condición dura
  // (una puerta abierta la sigue reportando). Sin dedup el operario recibe una
  // alarma por segundo de la MISMA puerta abierta.
  const key = `${panel.id}:${String(payload).slice(0, 200)}`;
  if (dedup(key)) return null;
  try {
    const ev = await ingestRaw("access", typeof payload === "string" ? { _raw: payload } : payload, {
      ctx: { deviceId: panel.id, deviceName: panel.name, site: panel.siteId, ip: panel.host },
    });
    if (ev) log.info(`${panel.name}: ${ev.type} → ${ev.id}`);
    return ev;
  } catch (e) {
    log.error(`${panel.name}: fallo la ingesta — ${e.message}`);
    return null;
  }
}

function runAlertStream(panel, stop) {
  if (!panel.host || !panel.user) {
    log.error(`${panel.name}: sin IP o usuario, no se puede usar alertStream`);
    return;
  }
  let buf = "";
  const mod = panel.https ? https : http;
  const ALERT_PATH = "/ISAPI/Event/notification/alertStream";
  const connect = (authHeader) => {
    if (stop.done) return;
    const headers = { Connection: "keep-alive", Accept: "*/*" };
    if (authHeader) headers.Authorization = authHeader;
    const req = mod.request({
      host: panel.host, port: panel.port, path: ALERT_PATH,
      method: "GET", headers,
    }, (res) => {
      // Los AX exigen Digest: primer intento sin auth → 401 con el challenge →
      // recomputamos y reconectamos con la cabecera Authorization.
      if (res.statusCode === 401 && !authHeader) {
        const wa = res.headers["www-authenticate"] || "";
        res.resume();
        const authz = /digest/i.test(wa)
          ? _digestAuth({ user: panel.user, pass: panel.pass, method: "GET", uri: ALERT_PATH, auth: _parseAuth(wa) })
          : "Basic " + Buffer.from(`${panel.user}:${panel.pass}`).toString("base64");
        return connect(authz);
      }
      if (res.statusCode !== 200) {
        log.error(`${panel.name}: alertStream HTTP ${res.statusCode}, reintento en ${RECONNECT_MS / 1000}s`);
        res.resume();
        return setTimeout(() => connect(), RECONNECT_MS).unref?.();
      }
      log.info(`${panel.name}: alertStream conectado (${panel.host}:${panel.port})`);
      res.setEncoding("utf8");
      res.on("data", (c) => {
        buf += c;
        const alerts = splitAlerts(buf);
        if (alerts.length) {
          buf = buf.slice(buf.lastIndexOf(alerts[alerts.length - 1]) + alerts[alerts.length - 1].length);
          for (const a of alerts) handleAlert(panel, a);
        }
        // Cortafuegos: si el equipo manda basura sin cerrar nunca una alerta,
        // el buffer no puede crecer sin techo.
        if (buf.length > 1_000_000) buf = buf.slice(-100_000);
      });
      // Reconexión fresca (sin auth) para renovar el nonce del digest.
      res.on("end", () => setTimeout(() => connect(), RECONNECT_MS).unref?.());
    });
    req.on("error", (e) => {
      log.error(`${panel.name}: ${e.message}, reintento en ${RECONNECT_MS / 1000}s`);
      setTimeout(() => connect(), RECONNECT_MS).unref?.();
    });
    req.end();
  };
  connect();
}

// ── Transporte 2: httpHosts (configurar el equipo para que nos empuje) ──────

/**
 * Deja cargado en el equipo el destino al que tiene que postear los eventos.
 * Es un PUT de configuración: **cambia el equipo**, así que no se corre solo al
 * arrancar — lo dispara el admin desde la UI y queda registrado.
 *
 * @param dev  dispositivo de la config
 * @param url  a dónde tiene que postear (el /api/ingest/access de EventOS)
 * @param opts { id=1, token, format="JSON", dryRun }
 */
export async function configureHttpHost(dev, url, opts = {}) {
  const { id = 1, format = "JSON", dryRun = false } = opts;
  const u = new URL(url);
  const body =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<HttpHostNotification version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema">` +
    `<id>${id}</id>` +
    `<url>${u.pathname}${u.search}</url>` +
    `<protocolType>${u.protocol === "https:" ? "HTTPS" : "HTTP"}</protocolType>` +
    `<parameterFormatType>${format}</parameterFormatType>` +
    `<addressingFormatType>ipaddress</addressingFormatType>` +
    `<ipAddress>${u.hostname}</ipAddress>` +
    `<portNo>${u.port || (u.protocol === "https:" ? 443 : 80)}</portNo>` +
    `<httpAuthenticationMethod>none</httpAuthenticationMethod>` +
    `</HttpHostNotification>`;
  const path = `/ISAPI/Event/notification/httpHosts/${id}`;
  if (dryRun) return { dryRun: true, path, body };
  const r = await digestRequest({
    host: dev.ip, port: Number(dev.isapiPort) || 80, https: !!dev.isapiHttps,
    path, method: "PUT", body, contentType: "application/xml",
    user: dev.username, pass: dev.password || "", timeoutMs: 8000,
  });
  return { ok: r.status >= 200 && r.status < 300, status: r.status, response: String(r.text || "").slice(0, 400) };
}

/**
 * Le pide al equipo que pruebe el destino. Es la unica forma de saber si el
 * panel LLEGA a EventOS antes de que pase algo de verdad — muy util cuando el
 * panel esta detras del NAT de un cliente y nosotros no lo alcanzamos.
 */
export async function testHttpHost(dev, id = 1) {
  const r = await digestRequest({
    host: dev.ip, port: Number(dev.isapiPort) || 80, https: !!dev.isapiHttps,
    path: `/ISAPI/Event/notification/httpHosts/${id}/test`,
    method: "POST", body: "", contentType: "application/xml",
    user: dev.username, pass: dev.password || "", timeoutMs: 10000,
  });
  return { ok: r.status >= 200 && r.status < 300, status: r.status, response: String(r.text || "").slice(0, 400) };
}

/** Qué destinos tiene cargados hoy (para no pisar los de otra plataforma). */
export async function listHttpHosts(dev) {
  const r = await digestGetBuffer({
    host: dev.ip, port: Number(dev.isapiPort) || 80, https: !!dev.isapiHttps,
    path: "/ISAPI/Event/notification/httpHosts",
    user: dev.username, pass: dev.password || "", timeoutMs: 8000,
  });
  const text = r.buffer ? r.buffer.toString("utf8") : "";
  const hosts = [...text.matchAll(/<HttpHostNotification>([\s\S]*?)<\/HttpHostNotification>/gi)]
    .map((m) => {
      const g = (n) => (new RegExp(`<${n}>([^<]*)</${n}>`, "i").exec(m[1]) || [])[1] || null;
      return { id: g("id"), url: g("url"), ip: g("ipAddress"), port: g("portNo"),
               protocol: g("protocolType"), format: g("parameterFormatType") };
    });
  return { status: r.status, hosts };
}

// ── Arranque ────────────────────────────────────────────────────────────────
let started = false;
const stop = { done: false };

export function startPanelIngest() {
  if (started) return;
  if (String(process.env.EVENTOS_PANELS || "") !== "1") {
    log.info("desactivado (EVENTOS_PANELS != 1)");
    return;
  }
  started = true;
  const panels = panelTargets();
  const pull = panels.filter((p) => p.transport === "alertstream" || p.transport === "both");
  for (const p of pull) runAlertStream(p, stop);
  const push = panels.filter((p) => p.transport === "http" || p.transport === "both");
  log.info(`${panels.length} panel(es): ${pull.length} por alertStream, ${push.length} esperando push en /api/ingest/access`);
}

export function stopPanelIngest() { stop.done = true; }

export default { startPanelIngest, panelTargets, configureHttpHost, testHttpHost, listHttpHosts, splitAlerts };
