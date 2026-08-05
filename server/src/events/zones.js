// Resolución de zonas Hikvision: regionID de un evento → nombre y geometría reales.
//
// Los eventos de cruce de línea / intrusión / entrada / salida traen un `regionID`
// (o `ID`) que por sí solo no dice nada: el operador ve "Región 1". Este módulo lo
// resuelve contra las reglas realmente dibujadas en cada cámara, para que el evento
// diga "Carga · zona" y el popup pueda pintar EXACTAMENTE el polígono que disparó.
//
// El mapa se genera con `isapi/tools/hik-audit.py` (auditoría ISAPI de sólo lectura)
// y vive en server/data/zones.json. Si el archivo no está, todo sigue funcionando
// igual que antes: resolve() devuelve null y normalize.js cae a "Región N".
//
// Regenerar cuando se dibujen o cambien reglas en las cámaras:
//   python3 isapi/tools/hik-audit.py --from-eventos --out /tmp/audit.json
//   python3 isapi/tools/build_zones.py /tmp/audit.json server/data/zones.json

import { readFileSync } from "node:fs";
import { resolve as pathResolve } from "node:path";

const FILE = process.env.EVENTOS_ZONES_FILE ||
  pathResolve(process.cwd(), "server/data/zones.json");

let cache = null;      // { zones, byChannel, generated }
let loadedAt = 0;
const TTL_MS = 60_000; // relee el archivo como mucho una vez por minuto

function load() {
  const now = Date.now();
  if (cache && now - loadedAt < TTL_MS) return cache;
  loadedAt = now;
  try {
    const doc = JSON.parse(readFileSync(FILE, "utf8"));
    const zones = doc.zones || {};
    const byChannel = new Map();     // `slug:ch:kind` → [zona, …]
    for (const [k, z] of Object.entries(zones)) {
      const base = k.split(":").slice(0, 3).join(":");
      if (!byChannel.has(base)) byChannel.set(base, []);
      byChannel.get(base).push(z);
    }
    cache = { zones, byChannel, generated: doc.generated || null };
  } catch {
    cache = { zones: {}, byChannel: new Map(), generated: null };
  }
  return cache;
}

/** Normaliza el eventType de Hik a la clave que usa el mapa. */
function kindOf(eventType = "") {
  const k = String(eventType).toLowerCase().replace(/[^a-z]/g, "");
  if (k.includes("linedetection")) return "linedetection";
  if (k.includes("fielddetection") || k.includes("intrusion")) return "fielddetection";
  if (k.includes("regionentrance")) return "regionentrance";
  if (k.includes("regionexiting") || k.includes("regionexit")) return "regionexiting";
  return null;
}

/**
 * Resuelve la zona que disparó un evento.
 * @param {string} slug      "srv1" | "srv2" (tag isapi:83 / isapi:82)
 * @param {string|number} channel  canal del NVR
 * @param {string} eventType linedetection | fielddetection | regionEntrance | …
 * @param {string|number} regionID  el regionID/ID del alert XML (puede venir null)
 * @returns {{name,camera,kind,label,ruleId,target,sensitivity,points,space,originBottomLeft}|null}
 */
export function resolveZone(slug, channel, eventType, regionID) {
  if (!slug || channel == null) return null;
  const kind = kindOf(eventType);
  if (!kind) return null;
  const { zones, byChannel } = load();

  if (regionID != null && String(regionID).trim() !== "") {
    const hit = zones[`${slug}:${channel}:${kind}:${String(regionID).trim()}`];
    if (hit) return hit;
  }
  // Sin regionID (o con uno que no matchea): si el canal tiene UNA sola regla de
  // ese tipo, es esa sin ambigüedad. Si tiene varias, no adivinamos.
  const list = byChannel.get(`${slug}:${channel}:${kind}`);
  if (list && list.length === 1) return list[0];
  return null;
}

/** Todas las zonas de un canal (para dibujar el contexto completo). */
export function zonesOfChannel(slug, channel) {
  const { byChannel } = load();
  const out = [];
  for (const kind of ["linedetection", "fielddetection", "regionentrance", "regionexiting"]) {
    const l = byChannel.get(`${slug}:${channel}:${kind}`);
    if (l) out.push(...l);
  }
  return out;
}

/** Metadatos del mapa cargado (para /api/health o el admin). */
export function zonesInfo() {
  const { zones, generated } = load();
  return { file: FILE, count: Object.keys(zones).length, generated };
}

export default { resolveZone, zonesOfChannel, zonesInfo };
