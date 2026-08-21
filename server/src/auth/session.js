// session.js — sesiones de operario por cookie (ARC público con login).
// El login emite una cookie HttpOnly `eventos_sid`; el server guarda el token
// en memoria (token → {operatorId, name, role, exp}) como lectura sync rápida, y
// ADEMÁS lo persiste en Postgres (tabla `sessions`) para que sobrevivan a un
// reinicio del server (el operario no tiene que re-loguear). Tolerante: si PG no
// está, funciona igual en memoria (comportamiento previo).
import { randomBytes } from "node:crypto";
import { query, pgEnabled } from "../db/pg.js";
import { log } from "../logger.js";

export const SESSION_COOKIE = "eventos_sid";
const TTL_MS = 12 * 60 * 60 * 1000; // 12 h

const sessions = new Map(); // token → { operatorId, name, role, exp }

function now() { return Date.now(); }

// Borra un token de PG (best-effort, nunca lanza).
function pgDelete(token) {
  if (pgEnabled() && token) query(`DELETE FROM sessions WHERE token = $1`, [token]).catch(() => {});
}

export function createSession({ operatorId, name, role }) {
  const token = randomBytes(24).toString("hex");
  const exp = now() + TTL_MS;
  sessions.set(token, { operatorId, name, role: role || "agente", exp });
  if (pgEnabled()) {
    query(
      `INSERT INTO sessions (token, operator_id, name, role, exp)
       VALUES ($1,$2,$3,$4, to_timestamp($5/1000.0))
       ON CONFLICT (token) DO UPDATE SET
         operator_id=EXCLUDED.operator_id, name=EXCLUDED.name, role=EXCLUDED.role, exp=EXCLUDED.exp`,
      [token, operatorId, name || null, role || "agente", exp]
    ).catch((e) => log.warn(`PG createSession: ${e.message}`));
  }
  return token;
}

export function getSession(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (s.exp < now()) { sessions.delete(token); pgDelete(token); return null; }
  return s;
}

export function destroySession(token) {
  if (token) { sessions.delete(token); pgDelete(token); }
}

// Rehidrata las sesiones vigentes desde PG al boot (y purga las expiradas).
// Devuelve cuántas cargó. Tolerante: si PG off/err, no hace nada.
export async function hydrateSessions() {
  if (!pgEnabled()) return 0;
  try {
    const r = await query(
      `SELECT token, operator_id, name, role, (extract(epoch from exp)*1000)::bigint AS exp
       FROM sessions WHERE exp > now()`
    );
    let n = 0;
    for (const row of r.rows || []) {
      sessions.set(row.token, { operatorId: row.operator_id, name: row.name, role: row.role, exp: Number(row.exp) });
      n++;
    }
    await query(`DELETE FROM sessions WHERE exp <= now()`); // limpia expiradas
    return n;
  } catch (e) { log.warn(`PG hydrateSessions: ${e.message}`); return 0; }
}

// Extrae el valor de una cookie de un header Cookie crudo (sin dependencias).
export function readCookie(cookieHeader, name = SESSION_COOKIE) {
  if (!cookieHeader || typeof cookieHeader !== "string") return null;
  for (const part of cookieHeader.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    const k = part.slice(0, i).trim();
    if (k === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

// Sesión asociada a un request Express (por su cookie).
export function sessionFromReq(req) {
  return getSession(readCookie(req.headers && req.headers.cookie));
}

// Sesión asociada a un handshake de socket.io.
export function sessionFromHandshake(handshake) {
  const h = (handshake && handshake.headers) || {};
  return getSession(readCookie(h.cookie));
}

// Opciones de la cookie de sesión. `secure` sólo si vamos por HTTPS detrás del
// proxy (X-Forwarded-Proto) o si SESSION_SECURE=1.
export function cookieOptions(req) {
  const xfproto = req && req.headers && req.headers["x-forwarded-proto"];
  const secure = process.env.SESSION_SECURE === "1" || xfproto === "https";
  return {
    httpOnly: true,
    sameSite: "lax",
    secure,
    maxAge: TTL_MS,
    path: "/",
  };
}

// Barrido de expiradas (evita crecimiento del Map + de la tabla).
setInterval(() => {
  const t = now();
  for (const [k, v] of sessions) if (v.exp < t) sessions.delete(k);
  if (pgEnabled()) query(`DELETE FROM sessions WHERE exp <= now()`).catch(() => {});
}, 10 * 60 * 1000).unref?.();

export default { createSession, getSession, destroySession, hydrateSessions, sessionFromReq, sessionFromHandshake, readCookie, cookieOptions, SESSION_COOKIE };
