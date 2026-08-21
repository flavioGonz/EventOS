// configRepo.js — persistencia de INVENTARIO/config en Postgres (write-through +
// carga al boot). Igual filosofía que eventsRepo: la caché en memoria del config
// store sigue siendo la fuente de lectura SYNC; PG es la persistencia durable, con
// escritura por-item (no reescribe todo el documento). Todo tolerante: si PG no está,
// no hace nada y el store sigue con memoria/JSON.
import { query, pgEnabled } from "./pg.js";
import { log } from "../logger.js";

const KV_KEYS = ["dispatch", "video", "evidence"];

// ── Colecciones-array (una fila por item) ────────────────────────────────────
export async function upsertItem(collection, item) {
  if (!pgEnabled() || !collection || !item || !item.id) return;
  try {
    await query(
      `INSERT INTO config_items (collection, id, doc, updated_at)
       VALUES ($1,$2,$3,now())
       ON CONFLICT (collection, id) DO UPDATE SET doc=EXCLUDED.doc, updated_at=now()`,
      [collection, item.id, JSON.stringify(item)]
    );
  } catch (e) { log.warn(`PG upsertItem ${collection}/${item.id}: ${e.message}`); }
}

export async function deleteItem(collection, id) {
  if (!pgEnabled() || !collection || !id) return;
  try { await query(`DELETE FROM config_items WHERE collection=$1 AND id=$2`, [collection, id]); }
  catch (e) { log.warn(`PG deleteItem ${collection}/${id}: ${e.message}`); }
}

// ── Ajustes-objeto (dispatch/video/evidence) ─────────────────────────────────
export async function upsertKv(key, obj) {
  if (!pgEnabled() || !key) return;
  try {
    await query(
      `INSERT INTO config_kv (key, doc, updated_at) VALUES ($1,$2,now())
       ON CONFLICT (key) DO UPDATE SET doc=EXCLUDED.doc, updated_at=now()`,
      [key, JSON.stringify(obj || {})]
    );
  } catch (e) { log.warn(`PG upsertKv ${key}: ${e.message}`); }
}

// ── Carga completa al boot ───────────────────────────────────────────────────
// Devuelve { items: {collection: [docs]}, kv: {key: obj}, total } o null si PG off.
export async function loadAll() {
  if (!pgEnabled()) return null;
  const items = {};
  const kv = {};
  let total = 0;
  try {
    const r = await query(`SELECT collection, doc FROM config_items`);
    for (const row of r.rows || []) {
      (items[row.collection] = items[row.collection] || []).push(row.doc);
      total++;
    }
    const k = await query(`SELECT key, doc FROM config_kv`);
    for (const row of k.rows || []) { if (KV_KEYS.includes(row.key)) kv[row.key] = row.doc; }
    return { items, kv, total };
  } catch (e) { log.warn(`PG loadAll config: ${e.message}`); return null; }
}

// Vuelca a PG el documento de config completo (colecciones + kv). Backfill inicial.
export async function backfillConfig(doc, collections) {
  if (!pgEnabled() || !doc) return 0;
  let n = 0;
  for (const col of collections) {
    const arr = Array.isArray(doc[col]) ? doc[col] : [];
    for (const item of arr) { try { await upsertItem(col, item); n++; } catch { /* best-effort */ } }
  }
  for (const key of KV_KEYS) { if (doc[key]) { try { await upsertKv(key, doc[key]); } catch { /* noop */ } } }
  return n;
}
