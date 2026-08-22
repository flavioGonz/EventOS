// auditRepo.js — bitácora de auditoría de acciones sensibles (no-repudio).
// Hoy: aperturas de puerta/relé. Best-effort y tolerante: si PG no está, no rompe
// la acción (pero SÍ deja rastro en el log de la app vía el llamador).
import { query, pgEnabled } from "./pg.js";
import { log } from "../logger.js";

// Registra una acción sensible. `entry`:
//   { action, operatorId, operatorName, deviceId, deviceName, detail, result, ip }
export async function auditLog(entry = {}) {
  if (!pgEnabled()) return;
  try {
    await query(
      `INSERT INTO audit_log (action, operator_id, operator_name, device_id, device_name, detail, result, ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        String(entry.action || "unknown"),
        entry.operatorId || null, entry.operatorName || null,
        entry.deviceId || null, entry.deviceName || null,
        entry.detail || null, entry.result || null, entry.ip || null,
      ]
    );
  } catch (e) { log.warn(`PG auditLog: ${e.message}`); }
}

// Lectura paginada por keyset (ts + id) para una futura pestaña de auditoría.
export async function listAudit({ limit = 100, before = null, deviceId = null, action = null } = {}) {
  if (!pgEnabled()) return { rows: [], nextBefore: null, pg: false };
  const where = []; const params = []; let i = 1;
  if (before) { where.push(`ts < $${i++}`); params.push(before); }
  if (deviceId) { where.push(`device_id = $${i++}`); params.push(deviceId); }
  if (action) { where.push(`action = $${i++}`); params.push(action); }
  const lim = Math.max(1, Math.min(500, Number(limit) || 100));
  const sql = `SELECT id, ts, action, operator_id, operator_name, device_id, device_name, detail, result, ip
               FROM audit_log ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY ts DESC LIMIT ${lim + 1}`;
  try {
    const r = await query(sql, params);
    const rows = r.rows || [];
    const hasMore = rows.length > lim;
    const page = rows.slice(0, lim);
    const last = page[page.length - 1];
    return { rows: page, nextBefore: hasMore && last ? new Date(last.ts).toISOString() : null, pg: true };
  } catch (e) { log.warn(`PG listAudit: ${e.message}`); return { rows: [], nextBefore: null, pg: true }; }
}

export default { auditLog, listAudit };
