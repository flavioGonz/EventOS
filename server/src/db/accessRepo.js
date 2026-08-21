// accessRepo.js — persistencia de LECTURAS DE ACCESO (badge en vivo + auditoría).
// Best-effort y tolerante: si PG no está, no hace nada (el badge igual se emite).
import { query, pgEnabled } from "./pg.js";
import { log } from "../logger.js";

export async function insertAccessRead(ar) {
  if (!pgEnabled() || !ar || !ar.id) return;
  try {
    await query(
      `INSERT INTO access_reads (id, ts, vendor, device_id, site, site_id, method, granted, person_name, person_id, photo_url, doc)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (id) DO NOTHING`,
      [
        ar.id, ar.ts || new Date().toISOString(), ar.vendor || null, ar.deviceId || null,
        ar.site || null, ar.siteId || null, ar.method || null, ar.granted !== false,
        ar.personName || null, ar.personId || null, ar.photoUrl || null, JSON.stringify(ar),
      ]
    );
  } catch (e) { log.warn(`PG insertAccessRead ${ar.id}: ${e.message}`); }
}

// Historial paginado por keyset (ts). Para una futura pestaña de auditoría de accesos.
export async function listAccessReads({ limit = 50, before = null, siteId = null, deviceId = null } = {}) {
  if (!pgEnabled()) return { reads: [], nextBefore: null, pg: false };
  const where = []; const params = []; let i = 1;
  if (before) { where.push(`ts < $${i++}`); params.push(before); }
  if (siteId) { where.push(`site_id = $${i++}`); params.push(siteId); }
  if (deviceId) { where.push(`device_id = $${i++}`); params.push(deviceId); }
  const lim = Math.max(1, Math.min(500, Number(limit) || 50));
  const sql = `SELECT doc, ts FROM access_reads ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY ts DESC LIMIT ${lim + 1}`;
  try {
    const r = await query(sql, params);
    const rows = r.rows || [];
    const hasMore = rows.length > lim;
    const page = rows.slice(0, lim);
    const last = page[page.length - 1];
    return { reads: page.map((x) => x.doc), nextBefore: hasMore && last ? new Date(last.ts).toISOString() : null, pg: true };
  } catch (e) { log.warn(`PG listAccessReads: ${e.message}`); return { reads: [], nextBefore: null, pg: true }; }
}

export default { insertAccessRead, listAccessReads };
