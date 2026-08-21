// crypto.js — cifrado en reposo de secretos (contraseñas de equipos).
//
// Diseño tolerante y retro-compatible:
//  - La clave sale de `ENC_KEY` (env). Si NO está definida, encEnabled()=false y
//    encrypt()/decrypt() son NO-OP → el sistema se comporta EXACTAMENTE como antes
//    (texto plano). Desplegar este código sin ENC_KEY no cambia nada.
//  - `decrypt(textoPlano)` devuelve el texto plano tal cual (solo descifra lo que
//    empieza con el prefijo `enc:v1:`). Así, valores viejos sin cifrar siguen
//    funcionando durante la transición — es IMPOSIBLE romper una lectura.
//  - AES-256-GCM (autenticado). La clave de 32 bytes se deriva con SHA-256 del
//    valor de ENC_KEY (acepta passphrase, hex o base64 indistintamente).
//
// ⚠️ Si se pierde ENC_KEY, los valores cifrados son irrecuperables. Guardala en
//    eventos.env (chmod 600) y respaldala aparte.
import crypto from "node:crypto";
import { log } from "../logger.js";

const PREFIX = "enc:v1:";
let key = null;
let warned = false;

function getKey() {
  if (key) return key;
  const raw = process.env.ENC_KEY;
  if (!raw || !String(raw).trim()) return null;
  key = crypto.createHash("sha256").update(String(raw)).digest(); // 32 bytes
  return key;
}

export function encEnabled() { return !!getKey(); }
export function isEncrypted(v) { return typeof v === "string" && v.startsWith(PREFIX); }

// Cifra un string. Si no hay clave o el valor es vacío/ya cifrado, lo devuelve igual.
export function encrypt(plain) {
  const k = getKey();
  if (k == null || plain == null || plain === "" || isEncrypted(plain)) return plain;
  try {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", k, iv);
    const ct = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return PREFIX + Buffer.concat([iv, tag, ct]).toString("base64");
  } catch (e) {
    if (!warned) { warned = true; log.warn(`crypto.encrypt falló (se deja en claro): ${e.message}`); }
    return plain;
  }
}

// Descifra. Si NO está cifrado (sin prefijo) devuelve el valor tal cual (retro-compat).
// Si está cifrado pero no hay clave / falla, devuelve el valor tal cual (no rompe la lectura;
// el equipo simplemente no autenticará hasta corregir la clave — señal clara, no un crash).
export function decrypt(v) {
  if (!isEncrypted(v)) return v;
  const k = getKey();
  if (k == null) return v;
  try {
    const raw = Buffer.from(v.slice(PREFIX.length), "base64");
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const ct = raw.subarray(28);
    const d = crypto.createDecipheriv("aes-256-gcm", k, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
  } catch (e) {
    if (!warned) { warned = true; log.warn(`crypto.decrypt falló (clave incorrecta?): ${e.message}`); }
    return v;
  }
}

export default { encEnabled, isEncrypted, encrypt, decrypt };
