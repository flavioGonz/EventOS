// config.js — lee variables de entorno con valores por defecto sensatos
import { randomUUID, createHash, timingSafeEqual } from "node:crypto";
import { log } from "./logger.js";

const env = process.env;

// Comparación de tokens en tiempo constante (evita timing attacks). Se comparan
// los digests SHA-256, de longitud fija, para no filtrar ni el largo del token.
export function tokensEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length === 0) return false;
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

// Genera un token de ingesta aleatorio si no viene definido
let ingestToken = env.INGEST_TOKEN && env.INGEST_TOKEN.trim();
if (!ingestToken) {
  ingestToken = "ing_" + randomUUID().replace(/-/g, "");
  log.warn(`INGEST_TOKEN no definido — generado uno temporal: ${ingestToken}`);
}

// Token de administración: si no se define, las rutas /api/admin quedan abiertas (modo dev)
const adminToken = (env.ADMIN_TOKEN && env.ADMIN_TOKEN.trim()) || undefined;
if (!adminToken) {
  log.warn("ADMIN_TOKEN no definido — las rutas /api/admin quedan ABIERTAS (modo dev)");
}

export const config = {
  host: env.HOST || "127.0.0.1",
  port: Number(env.PORT) || 4010,
  nodeEnv: env.NODE_ENV || "development",
  redisUrl: (env.REDIS_URL && env.REDIS_URL.trim()) || "",
  ingestToken,
  adminToken,
  corsOrigin: env.CORS_ORIGIN || "*",
};

// Aviso de seguridad: CORS abierto en producción es riesgoso (cualquier origen
// puede llamar a la API/consola). Igual que con los tokens, lo advertimos.
if (!env.CORS_ORIGIN && config.nodeEnv === "production") {
  log.warn("CORS_ORIGIN no definido en producción — se permite cualquier origen ('*'). Fija el dominio de nginx.");
}

export default config;
