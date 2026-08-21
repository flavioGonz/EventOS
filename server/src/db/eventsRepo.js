// eventsRepo.js — persistencia de EVENTOS en Postgres (write-through best-effort +
// consulta paginada de historial). Todo es tolerante: si PG no está, no hace nada
// y el estado en memoria/JSON sigue siendo la fuente en vivo.
import { query, pgEnabled } from "./pg.js";
import { log } from "../logger.js";

function cols(e) {
  const s = e.source || {};
  const pr = Number.isFinite(e.priority) ? e.priority : (e.priority != null ? Number(e.priority) : null);
  return [
    e.id,
    e.ts || new Date().toISOString(),
    e.deviceTs || null,
    e.status || null,
    e.disposition || null,
    Number.isFinite(pr) ? pr : null,
    e.type || null,
    s.deviceId || null,
    s.site || e.site || null,
    e.assignedTo || null,
    JSON.stringify(e),
  ];
}

const UPSERT = `
  INSERT INTO events (id,ts,device_ts,status,disposition,priority,type,device_id,site,assigned_to,doc,updated_at)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now())
  ON CONFLICT (id) DO UPDATE SET
    ts=EXCLUDED.ts, device_ts=EXCLUDED.device_ts, status=EXCLUDED.status, disposition=EXCLUDED.disposition,
    priority=EXCLUDED.priority, type=EXCLUDED.type, device_id=EXCLUDED.device_id, site=EXCLUDED.site,
    assigned_to=EXCLUDED.assigned_to, doc=EXCLUDED.doc, updated_at=now()`;

// Escritura best-effort: nunca lanza (no debe frenar el flujo de eventos en vivo).
export async function upsertEvent(e) {
  if (!pgEnabled() || !e || !e.id) return;
  try { await query(UPSERT, cols(e)); }
  catch (err) { log.warn(`PG upsert evento ${e.id}: ${err.message}`); }
}

// Historial paginado por keyset (ts). `before` = ISO string (trae los anteriores).
export async function listHistory({ limit = 50, before = null, status = null, site = null, deviceId = null } = {}) {
  if (!pgEnabled()) return { events: [], nextBefore: null, pg: false };
  const where = []; const params = []; let i = 1;
  if (before) { where.push(`ts < $${i++}`); params.push(before); }
  if (status) { where.push(`status = $${i++}`); params.push(status); }
  if (site) { where.push(`site = $${i++}`); params.push(site); }
  if (deviceId) { where.push(`device_id = $${i++}`); params.push(deviceId); }
  const lim = Math.max(1, Math.min(500, Number(limit) || 50));
  const sql = `SELECT doc, ts FROM events ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY ts DESC LIMIT ${lim + 1}`;
  const r = await query(sql, params);
  const rows = r.rows || [];
  const hasMore = rows.length > lim;
  const page = rows.slice(0, lim);
  const last = page[page.length - 1];
  const nextBefore = hasMore && last ? new Date(last.ts).toISOString() : null;
  return { events: page.map((x) => x.doc), nextBefore, pg: true };
}

export async function countEvents() {
  if (!pgEnabled()) return 0;
  try { const r = await query(`SELECT count(*)::int AS n FROM events`); return (r.rows && r.rows[0] && r.rows[0].n) || 0; }
  catch { return 0; }
}

// Estados "en cola" (no resueltos). Espejo de ACTIVE_STATUSES en dispatch/store.js.
const ACTIVE_STATUSES = ["new", "assigned", "ack", "in_progress", "escalated"];

// Eventos ACTIVOS (cola en vivo) para rehidratar la memoria al boot. null si PG off/err.
export async function loadActive() {
  if (!pgEnabled()) return null;
  try {
    const r = await query(`SELECT doc FROM events WHERE status = ANY($1) ORDER BY ts DESC`, [ACTIVE_STATUSES]);
    return (r.rows || []).map((x) => x.doc);
  } catch (e) { log.warn(`PG loadActive: ${e.message}`); return null; }
}

// Últimos N resueltos (para la cola acotada de resueltos recientes). null si PG off/err.
export async function loadRecentResolved(limit = 200) {
  if (!pgEnabled()) return null;
  try {
    const lim = Math.max(1, Math.min(1000, Number(limit) || 200));
    const r = await query(`SELECT doc FROM events WHERE status = 'resolved' ORDER BY ts DESC LIMIT ${lim}`);
    return (r.rows || []).map((x) => x.doc);
  } catch (e) { log.warn(`PG loadRecentResolved: ${e.message}`); return null; }
}
