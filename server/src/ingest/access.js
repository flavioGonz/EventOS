// access.js — LECTURAS DE ACCESO de porteros (tag/PIN/rostro/QR válidos).
//
// Modelo canónico `AccessRead` (independiente de marca) para que sumar otra marca
// de portero en el futuro sea sólo un adaptador nuevo, sin tocar la UI ni el socket:
//   { id, ts, vendor, deviceId, deviceName, siteId, site, method:'card'|'pin'|'face'|'qr',
//     granted, personName, personId?, photoUrl?, raw }
//
// Estas lecturas NO son alarmas: no van a la cola de eventos. Se emiten como badge
// efímero al vivo (socket `access:read`) y se registran en PG (auditoría). Las
// lecturas de RIESGO (invalid*, tamper, break-in, input) siguen siendo alarmas por
// el pipeline normal.
import { randomUUID } from "node:crypto";
import { log } from "../logger.js";
import * as store from "../config/store.js";
import { logs as akuvoxLogs } from "../discovery/akuvox.js";
import { insertAccessRead } from "../db/accessRepo.js";
import { emitAccessRead } from "../socket/emitter.js";

// Eventos Akuvox (Action URL) que son ACCESO CONCEDIDO → método canónico.
const AKUVOX_READS = {
  validcard: { method: "card", granted: true },
  validcode: { method: "pin",  granted: true },
  validface: { method: "face", granted: true },
  validqr:   { method: "qr",   granted: true },
};

export function isAkuvoxAccessRead(q) {
  return !!(q && q.event && AKUVOX_READS[String(q.event).toLowerCase()]);
}

function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
}

function akuvoxOpt(dev) {
  const host = String(dev.ip || dev.camIp || "").replace(/^https?:\/\//, "").replace(/:\d+$/, "");
  const port = Number(dev.isapiPort) || (dev.isapiHttps ? 443 : 80);
  const secure = dev.isapiHttps !== undefined ? !!dev.isapiHttps : port === 443 || port === 8082;
  return { host, port, user: dev.username || "", pass: dev.password || "", https: secure };
}

// Nombre del último acceso vía doorlog del portero (best-effort, timeout corto).
// El doorlog viene ordenado por el equipo; el primer 'door' es el acceso más reciente.
async function resolveAkuvoxName(dev) {
  try {
    const opt = akuvoxOpt(dev);
    if (!opt.host || !opt.user) return null;
    const arr = await withTimeout(akuvoxLogs(opt, 5), 2500);
    const door = (Array.isArray(arr) ? arr : []).filter((x) => x.kind === "door");
    return door.length ? (door[0].user || null) : null;
  } catch { return null; }
}

// Adaptador Akuvox → AccessRead. Emite el badge + persiste. Devuelve el AccessRead o null.
export async function handleAkuvoxAccessRead(q, dev) {
  const spec = AKUVOX_READS[String(q.event || "").toLowerCase()];
  if (!spec || !dev) return null;
  const site = store.get("sites", dev.siteId) || null;
  const personName = await resolveAkuvoxName(dev);
  const ar = {
    id: `acc_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
    ts: new Date().toISOString(),
    vendor: "akuvox",
    deviceId: dev.id,
    deviceName: dev.name || null,
    siteId: dev.siteId || null,
    site: (site && site.name) || dev.site || null,
    method: spec.method,
    granted: spec.granted,
    personName: personName || null,
    personId: null,
    photoUrl: null,
    raw: { event: q.event, card: q.card || null, code: q.code ? "***" : null },
  };
  insertAccessRead(ar).catch(() => {});
  emitAccessRead(ar);
  log.info(`acceso[akuvox] ${dev.name || dev.id}: ${spec.method}${personName ? " · " + personName : ""} → badge`);
  return ar;
}

export default { isAkuvoxAccessRead, handleAkuvoxAccessRead };
