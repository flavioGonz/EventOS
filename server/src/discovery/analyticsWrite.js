// analyticsWrite.js — Escribe/edita las analíticas dibujadas EN LA CÁMARA por ISAPI.
// Lee el config Smart actual del canal, reemplaza SOLO la lista de coordenadas de
// la primera regla, y lo re-sube por PUT. Así conserva sensibilidad, umbrales,
// enabled, etc. Coordenadas normalizadas 0–1000, origen abajo-izquierda (el
// cliente ya invierte la Y antes de mandar).
import { digestGetBuffer, digestRequest } from "../util/digestFetch.js";

// Por tipo: ruta ISAPI, elemento de coordenada y de lista.
export const SMART = {
  line: { path: "LineDetection", coordEl: "Coordinates", listEl: "CoordinatesList", enable: true },
  field: { path: "FieldDetection", coordEl: "RegionCoordinates", listEl: "RegionCoordinatesList", enable: true },
  entrance: { path: "regionEntrance", coordEl: "RegionCoordinates", listEl: "RegionCoordinatesList", enable: false },
  exiting: { path: "regionExiting", coordEl: "RegionCoordinates", listEl: "RegionCoordinatesList", enable: false },
  baggage: { path: "unattendedBaggage", coordEl: "RegionCoordinates", listEl: "RegionCoordinatesList", enable: false },
  takenaway: { path: "attendedBaggage", coordEl: "RegionCoordinates", listEl: "RegionCoordinatesList", enable: false },
};

const clamp = (n) => Math.max(0, Math.min(1000, Math.round(Number(n) || 0)));

// Reemplaza la PRIMERA lista de coordenadas del XML con los puntos dados.
function rewriteCoords(xml, s, points) {
  const coords = points
    .map((p) => `<${s.coordEl}><positionX>${clamp(p.x)}</positionX><positionY>${clamp(p.y)}</positionY></${s.coordEl}>`)
    .join("");
  const listRe = new RegExp(`(<${s.listEl}>)[\\s\\S]*?(</${s.listEl}>)`);
  if (!listRe.test(xml)) return null; // el equipo no expone esa lista → no tocar
  return xml.replace(listRe, `$1${coords}$2`);
}

// deviceInfo del store no se usa acá: el caller pasa host/port/creds/canal.
export async function saveAnalytics({ host, port, https, user, pass, channelIds, type, points }) {
  const s = SMART[type];
  if (!s) return { ok: false, error: "bad_type" };
  const base = { host, port: Number(port), https: !!https, user, pass: pass || "", timeoutMs: 8000 };
  let lastStatus = 0;
  for (const chId of channelIds) {
    const path = `/ISAPI/Smart/${s.path}/${chId}`;
    let g;
    try { g = await digestGetBuffer({ ...base, path }); } catch { continue; }
    lastStatus = g.status;
    if (g.status !== 200) continue;
    const xml = g.buffer.toString("utf8");
    const body = rewriteCoords(xml, s, points);
    if (!body) continue;
    const r = await digestRequest({ ...base, path, method: "PUT", body, contentType: "application/xml" });
    const txt = r.text || "";
    const ok = /<statusCode>\s*1\s*<\/statusCode>/.test(txt) || /statusString>\s*OK/i.test(txt) || (r.status >= 200 && r.status < 300);
    return { ok, status: r.status, channel: chId, resp: txt.replace(/\s+/g, " ").slice(0, 300) };
  }
  return { ok: false, error: "no_channel", status: lastStatus };
}

export default { saveAnalytics, SMART };
