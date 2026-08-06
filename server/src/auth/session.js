// session.js — sesiones de operario por cookie (ARC público con login).
// El login emite una cookie HttpOnly `eventos_sid`; el server guarda el token
// en memoria (token → {operatorId, name, role, exp}). Se valida en cada acción
// física, en el video y en el handshake del socket. En memoria a propósito: un
// restart obliga a re-loguear (barato) y no deja sesiones colgadas en disco.
import { randomBytes } from "node:crypto";

export const SESSION_COOKIE = "eventos_sid";
const TTL_MS = 12 * 60 * 60 * 1000; // 12 h

const sessions = new Map(); // token → { operatorId, name, role, exp }

function now() { return Date.now(); }

export function createSession({ operatorId, name, role }) {
  const token = randomBytes(24).toString("hex");
  sessions.set(token, { operatorId, name, role: role || "agente", exp: now() + TTL_MS });
  return token;
}

export function getSession(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (s.exp < now()) { sessions.delete(token); return null; }
  return s;
}

export function destroySession(token) {
  if (token) sessions.delete(token);
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

// Barrido de expiradas (evita crecimiento del Map).
setInterval(() => {
  const t = now();
  for (const [k, v] of sessions) if (v.exp < t) sessions.delete(k);
}, 10 * 60 * 1000).unref?.();

export default { createSession, getSession, destroySession, sessionFromReq, sessionFromHandshake, readCookie, cookieOptions, SESSION_COOKIE };
