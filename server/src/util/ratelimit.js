// ratelimit.js — limitador en memoria, sin dependencias, para frenar fuerza bruta
// de credenciales (login) y del token de ingesta. Ventana deslizante por clave
// (p.ej. IP o IP+usuario). Tolerante: es best-effort, nunca lanza.
//
// Diseño para una ARC: NO limitamos ingestas VÁLIDAS (no queremos jamás descartar
// una alarma real durante una tormenta); sólo contamos INTENTOS FALLIDOS de auth.
const buckets = new Map(); // key -> { count, resetAt }

// ¿Se permite este intento? Cuenta el intento y devuelve false si superó el tope.
export function rateHit(key, max = 10, windowMs = 5 * 60 * 1000) {
  try {
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || now >= b.resetAt) { b = { count: 0, resetAt: now + windowMs }; buckets.set(key, b); }
    b.count++;
    return b.count <= max;
  } catch { return true; }
}

// Limpia el contador de una clave (p.ej. tras un login exitoso).
export function rateReset(key) { try { buckets.delete(key); } catch { /* noop */ } }

// Barrido periódico de buckets vencidos para no crecer sin límite.
setInterval(() => {
  try {
    const now = Date.now();
    for (const [k, b] of buckets) if (now >= b.resetAt) buckets.delete(k);
  } catch { /* noop */ }
}, 60 * 1000).unref?.();

// IP del cliente respetando el proxy (nginx) vía X-Forwarded-For.
export function clientIp(req) {
  const xf = req.headers["x-forwarded-for"];
  if (xf) return String(xf).split(",")[0].trim();
  return req.ip || req.socket?.remoteAddress || "unknown";
}

export default { rateHit, rateReset, clientIp };
