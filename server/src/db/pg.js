// pg.js — capa de acceso a PostgreSQL (opcional y tolerante).
// Si DATABASE_URL no está definido o PG está caído, `pgEnabled()` es false y TODO
// el resto del sistema sigue funcionando con el estado en memoria + JSON (la
// migración es incremental: PG es la persistencia durable/consultable, no un
// requisito para arrancar). Empezamos por EVENTOS.
import pg from "pg";
import { log } from "../logger.js";

let pool = null;
let enabled = false;

export function initDb() {
  const url = process.env.DATABASE_URL;
  if (!url) { log.info("PG: DATABASE_URL no definido → sin Postgres (estado en memoria/JSON)"); return false; }
  try {
    pool = new pg.Pool({ connectionString: url, max: 6, idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000 });
    pool.on("error", (e) => log.warn(`PG pool error: ${e.message}`));
    enabled = true;
    log.info("PG: pool inicializado");
    return true;
  } catch (e) {
    log.warn(`PG init falló: ${e.message}`);
    enabled = false;
    return false;
  }
}

export function pgEnabled() { return enabled; }

export async function query(text, params) {
  if (!enabled) return { rows: [] };
  return pool.query(text, params);
}

// Crea el esquema si no existe (idempotente). Sólo tabla de eventos por ahora.
export async function migrate() {
  if (!enabled) return;
  await query(`
    CREATE TABLE IF NOT EXISTS events (
      id           text PRIMARY KEY,
      ts           timestamptz NOT NULL,
      device_ts    timestamptz,
      status       text,
      disposition  text,
      priority     int,
      type         text,
      device_id    text,
      site         text,
      assigned_to  text,
      doc          jsonb NOT NULL,
      updated_at   timestamptz NOT NULL DEFAULT now()
    )`);
  await query(`CREATE INDEX IF NOT EXISTS events_ts_idx ON events (ts DESC)`);
  await query(`CREATE INDEX IF NOT EXISTS events_status_ts_idx ON events (status, ts DESC)`);
  await query(`CREATE INDEX IF NOT EXISTS events_site_ts_idx ON events (site, ts DESC)`);
  await query(`CREATE INDEX IF NOT EXISTS events_device_ts_idx ON events (device_id, ts DESC)`);

  // Inventario/config: colecciones-array (devices, sites, operators, groups, rules,
  // procedures, clientGroups) como filas por-item; y ajustes-objeto (dispatch, video,
  // evidence) en un KV. La caché en memoria sigue siendo la fuente de lectura sync.
  await query(`
    CREATE TABLE IF NOT EXISTS config_items (
      collection text NOT NULL,
      id         text NOT NULL,
      doc        jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (collection, id)
    )`);
  await query(`CREATE INDEX IF NOT EXISTS config_items_col_idx ON config_items (collection)`);
  await query(`
    CREATE TABLE IF NOT EXISTS config_kv (
      key        text PRIMARY KEY,
      doc        jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);

  // Sesiones de operario (cookie eventos_sid): durables para sobrevivir reinicios
  // del server (el operario no re-loguea). La lectura sync sigue siendo el Map en
  // memoria; PG es respaldo + hidratación al boot.
  await query(`
    CREATE TABLE IF NOT EXISTS sessions (
      token       text PRIMARY KEY,
      operator_id text,
      name        text,
      role        text,
      exp         timestamptz NOT NULL
    )`);
  await query(`CREATE INDEX IF NOT EXISTS sessions_exp_idx ON sessions (exp)`);

  // Lecturas de acceso de porteros (tag/PIN/rostro válidos): histórico/auditoría.
  // NO son alarmas de la cola; se muestran como badge efímero en el vivo y se
  // registran acá para "quién entró, cuándo, por qué portero".
  await query(`
    CREATE TABLE IF NOT EXISTS access_reads (
      id          text PRIMARY KEY,
      ts          timestamptz NOT NULL,
      vendor      text,
      device_id   text,
      site        text,
      site_id     text,
      method      text,
      granted     boolean,
      person_name text,
      person_id   text,
      photo_url   text,
      doc         jsonb
    )`);
  await query(`CREATE INDEX IF NOT EXISTS access_reads_ts_idx ON access_reads (ts DESC)`);
  await query(`CREATE INDEX IF NOT EXISTS access_reads_site_ts_idx ON access_reads (site_id, ts DESC)`);
  log.info("PG: esquema eventos + inventario + sesiones + accesos listo (migrate)");
}

export async function ping() {
  if (!enabled) return false;
  try { await query("SELECT 1"); return true; } catch { return false; }
}
