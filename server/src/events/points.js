// points.js — registro de PUNTOS, vendor-neutral.
//
// EL PROBLEMA QUE RESUELVE, y por qué vive en el núcleo y no en un ingester:
// todo equipo de ARC manda un identificador opaco que el operario no entiende.
// Hikvision manda `regionID 1`. Un panel de alarma manda `zona 3`. Un control de
// acceso manda `puerta 2`. Un Dahua mandará lo suyo. Todos necesitan lo mismo:
// traducir (dispositivo, tipo, id) → nombre humano (+ geometría, si hay).
//
// Por eso el índice es el **deviceId de EventOS**: es identidad propia, única
// entre clientes y marcas. NO se indexa por convenciones del fabricante (puerto,
// slug de NVR, nº de canal), que colisionan apenas entra el segundo cliente.
//
// Cada adaptador de marca sólo tiene que dejar `pointKind` + `pointId` canónicos
// en los fields; `buildEvent()` hace la resolución una sola vez para todos.
//
// Kinds canónicos:
//   line      cruce de línea (video)
//   region    zona de intrusión (video)
//   entrance  entrada a zona          exiting  salida de zona
//   zone      zona de panel de alarma
//   door      puerta / lectora de control de acceso
//   input     entrada IO              output   salida IO / relé
//
// Formato de server/data/points.json:
//   { "generated": "...",
//     "points": { "<deviceId>": { "<kind>:<id>": {name, kind, id, geometry?, meta?} } },
//     "aliases": { "<slugVendor>:<canal>": "<deviceId>" } }   ← compatibilidad
//
// Si el archivo no está, resolvePoint() devuelve null y todo sigue igual que
// antes: es aditivo, no puede romper nada.

import { readFileSync } from "node:fs";
import { resolve as pathResolve } from "node:path";

const FILE = process.env.EVENTOS_POINTS_FILE ||
  pathResolve(process.cwd(), "server/data/points.json");

let cache = null;
let loadedAt = 0;
const TTL_MS = 60_000;

function load() {
  const now = Date.now();
  if (cache && now - loadedAt < TTL_MS) return cache;
  loadedAt = now;
  try {
    const doc = JSON.parse(readFileSync(FILE, "utf8"));
    cache = {
      points: doc.points || {},
      aliases: doc.aliases || {},
      generated: doc.generated || null,
    };
  } catch {
    cache = { points: {}, aliases: {}, generated: null };
  }
  return cache;
}

/** Normaliza el tipo de punto que manda cada marca al kind canónico. */
export function pointKindOf(vendorType = "") {
  const k = String(vendorType).toLowerCase().replace(/[^a-z]/g, "");
  if (!k) return null;
  if (k.includes("linedetection") || k === "line") return "line";
  if (k.includes("fielddetection") || k.includes("intrusion") || k === "region") return "region";
  if (k.includes("regionentrance") || k === "entrance") return "entrance";
  if (k.includes("regionexiting") || k.includes("regionexit") || k === "exiting") return "exiting";
  if (k.includes("unattendedbaggage") || k === "baggage") return "baggage";
  if (k.includes("attendedbaggage") || k === "takenaway") return "takenaway";
  if (k === "zone" || k.includes("partition")) return "zone";
  if (k === "door" || k.includes("reader") || k.includes("lector")) return "door";
  if (k === "input") return "input";
  if (k === "output" || k.includes("relay") || k.includes("rele")) return "output";
  return null;
}

/**
 * Resuelve un punto a su nombre humano.
 * @param {string} deviceId  id del dispositivo EN EVENTOS (no del fabricante)
 * @param {string} kind      kind canónico (ver pointKindOf)
 * @param {string|number} id id que mandó el equipo (regionID, zona, puerta…)
 * @returns {{name,kind,id,geometry?,meta?}|null}
 */
export function resolvePoint(deviceId, kind, id) {
  if (!deviceId || !kind) return null;
  const { points } = load();
  const dev = points[deviceId];
  if (!dev) return null;

  if (id != null && String(id).trim() !== "") {
    const hit = dev[`${kind}:${String(id).trim()}`];
    if (hit) return hit;
  }
  // Sin id (o con uno que no matchea): si el dispositivo tiene UN SOLO punto de
  // ese kind, es ese sin ambigüedad. Con varios NO adivinamos — vale más no
  // nombrar que nombrar mal: en un ARC un nombre equivocado manda a un operario
  // al lugar equivocado.
  const same = Object.entries(dev).filter(([k]) => k.startsWith(`${kind}:`));
  return same.length === 1 ? same[0][1] : null;
}

/** Resolución por alias de fabricante (`slug:canal`) cuando no hay deviceId. */
export function resolvePointByAlias(alias, kind, id) {
  if (!alias) return null;
  const { aliases } = load();
  const deviceId = aliases[alias];
  return deviceId ? resolvePoint(deviceId, kind, id) : null;
}

/** Todos los puntos de un dispositivo (para dibujar el contexto completo). */
export function pointsOfDevice(deviceId) {
  const { points } = load();
  return Object.values(points[deviceId] || {});
}

export function pointsInfo() {
  const { points, aliases, generated } = load();
  const devices = Object.keys(points).length;
  const total = Object.values(points).reduce((n, d) => n + Object.keys(d).length, 0);
  return { file: FILE, devices, points: total, aliases: Object.keys(aliases).length, generated };
}

export default { resolvePoint, resolvePointByAlias, pointsOfDevice, pointsInfo, pointKindOf };
