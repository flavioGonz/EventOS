// pin.js — hash/verificación de PIN de operario (scrypt nativo, sin dependencias).
// El PIN viaja del cliente al server una vez y se guarda SOLO hasheado (salt:hash).
// Nunca se devuelve el hash al cliente.
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export function hashPin(pin) {
  const p = String(pin || "");
  if (!p) return null;
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(p, salt, 32).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPin(pin, stored) {
  try {
    if (!stored || typeof stored !== "string" || !stored.includes(":")) return false;
    const [salt, hash] = stored.split(":");
    const calc = scryptSync(String(pin || ""), salt, 32).toString("hex");
    const a = Buffer.from(hash, "hex");
    const b = Buffer.from(calc, "hex");
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export default { hashPin, verifyPin };
