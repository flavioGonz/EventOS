// ingest.js — rutas /api/ingest/* (CONTRACT §3)
// Auth por header X-Ingest-Token o query ?token=. Pipeline compartido.
import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, tokensEqual } from "../config.js";
import { log } from "../logger.js";
import { ingestRaw } from "../dispatch/pipeline.js";

const router = Router();

// ── Volcado de ingesta (diagnóstico de evidencias) ──────────────────────────
// Si existe el centinela data/DUMP_INGEST, guarda el payload CRUDO de cada evento
// (bytes intactos vía req.rawBody) en data/ingest-dumps/, para inspeccionar el
// formato real del multipart Hikvision (XML + JPEG). Tope de seguridad y a prueba
// de fallos: NUNCA interrumpe la ingesta.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "..", "..", "data");
const DUMP_DIR = path.join(DATA_DIR, "ingest-dumps");
const DUMP_FLAG = path.join(DATA_DIR, "DUMP_INGEST");
let dumpCount = 0;
function maybeDump(vendor, req) {
  try {
    if (!fs.existsSync(DUMP_FLAG) || dumpCount >= 30) return;
    fs.mkdirSync(DUMP_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const base = path.join(DUMP_DIR, `${ts}-${vendor}`);
    const ct = req.headers["content-type"] || "";
    fs.writeFileSync(`${base}.headers.txt`, `content-type: ${ct}\nmethod: ${req.method}\nurl: ${req.originalUrl}\nbytes: ${req.rawBody ? req.rawBody.length : "n/a"}\n`);
    if (Buffer.isBuffer(req.rawBody)) fs.writeFileSync(`${base}.bin`, req.rawBody);
    else fs.writeFileSync(`${base}.txt`, typeof req.body === "string" ? req.body : JSON.stringify(req.body || {}));
    dumpCount++;
    log.info(`[dump] payload de ingesta guardado (${vendor}) → ${base}.bin`);
  } catch { /* el volcado nunca rompe la ingesta */ }
}

// Middleware de autenticación de ingesta (comparación en tiempo constante).
function requireToken(req, res, next) {
  const token = req.get("X-Ingest-Token") || req.query.token;
  if (!tokensEqual(token, config.ingestToken)) {
    return res.status(401).json({ error: "unauthorized", message: "token de ingesta inválido" });
  }
  next();
}

router.use(requireToken);

// Extrae el JPEG del payload multipart (XML + imagen) de Hikvision, de forma
// DEFENSIVA y desde los bytes CRUDOS fieles (req.rawBody). Devuelve Buffer o null.
// Nunca lanza: ante cualquier rareza, devuelve null y la ingesta sigue su curso.
function extractMultipartImage(req) {
  try {
    const ct = req.headers["content-type"] || "";
    if (!/multipart\/form-data/i.test(ct) || !Buffer.isBuffer(req.rawBody)) return null;
    const bm = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ct);
    const boundary = bm ? (bm[1] || bm[2]).trim() : null;
    if (!boundary) return null;
    const buf = req.rawBody;
    const delim = Buffer.from("--" + boundary);
    let idx = buf.indexOf(delim);
    while (idx !== -1) {
      const next = buf.indexOf(delim, idx + delim.length);
      if (next === -1) break;
      const part = buf.slice(idx + delim.length, next);
      const sep = part.indexOf(Buffer.from("\r\n\r\n"));
      if (sep !== -1) {
        const headers = part.slice(0, sep).toString("latin1").toLowerCase();
        if (/content-type:\s*image\//.test(headers) || /filename="[^"]*\.jpe?g"/i.test(headers)) {
          let body = part.slice(sep + 4);
          if (body.length >= 2 && body[body.length - 2] === 0x0d && body[body.length - 1] === 0x0a) {
            body = body.slice(0, body.length - 2); // quitar CRLF final de la parte
          }
          if (body.length > 200) return body; // tamaño razonable de un JPEG
        }
      }
      idx = next;
    }
  } catch { /* nunca romper la ingesta */ }
  return null;
}

// Fábrica de handlers: un endpoint por fabricante
function makeHandler(vendor) {
  return async (req, res) => {
    maybeDump(vendor, req); // diagnóstico opcional (centinela), no afecta el flujo
    try {
      // Si llegó texto/XML crudo, lo envolvemos como { _raw: "<...>" } para auditoría
      let body = req.body;
      if (typeof body === "string") body = { _raw: body };
      if (!body || typeof body !== "object") body = {};
      const image = extractMultipartImage(req); // foto del evento (evidencia), si viene
      const event = await ingestRaw(vendor, body, { image });
      log.info(`Ingesta ${vendor}: ${event.type} → ${event.id} (p${event.priority})`);
      res.status(201).json({ event });
    } catch (err) {
      log.error(`Error en ingesta ${vendor}: ${err.message}`);
      res.status(500).json({ error: "ingest_failed", message: err.message });
    }
  };
}

router.post("/hikvision", makeHandler("hikvision"));
router.post("/akuvox", makeHandler("akuvox"));
router.post("/nvr", makeHandler("nvr"));
router.post("/alarm", makeHandler("alarm"));
router.post("/generic", makeHandler("generic"));

export default router;
