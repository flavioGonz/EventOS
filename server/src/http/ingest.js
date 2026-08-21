// ingest.js — rutas /api/ingest/* (CONTRACT §3)
// Auth por header X-Ingest-Token o query ?token=. Pipeline compartido.
import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, tokensEqual } from "../config.js";
import { log } from "../logger.js";
import { ingestRaw } from "../dispatch/pipeline.js";
import * as store from "../config/store.js";
import { isAkuvoxAccessRead, handleAkuvoxAccessRead } from "../ingest/access.js";

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
      // null = el normalizador decidio no emitir (p.ej. el eco de una apertura
      // que ordenamos nosotros). Se responde 202: recibido y descartado a
      // proposito, que no es lo mismo que un error.
      if (event === null) {
        log.info(`Ingesta ${vendor}: descartado (eco de una orden propia)`);
        return res.status(202).json({ ignored: true, reason: "echo" });
      }
      log.info(`Ingesta ${vendor}: ${event.type} → ${event.id} (p${event.priority})`);
      res.status(201).json({ event });
    } catch (err) {
      log.error(`Error en ingesta ${vendor}: ${err.message}`);
      res.status(500).json({ error: "ingest_failed", message: err.message });
    }
  };
}

// Resuelve el dispositivo EventOS a partir de la IP/MAC que trae un Action URL,
// para atribuir el evento (deviceId + sitio). Tolerante: si no matchea, no rompe.
function resolveDeviceByNet({ ip, mac }) {
  try {
    const devs = store.list("devices") || [];
    const m = String(mac || "").replace(/[:-]/g, "").toLowerCase();
    return devs.find((d) => {
      if (ip && (d.ip === ip || d.camIp === ip)) return true;
      if (m && String(d.mac || "").replace(/[:-]/g, "").toLowerCase() === m) return true;
      return false;
    }) || null;
  } catch { return null; }
}

router.post("/hikvision", makeHandler("hikvision"));
router.post("/akuvox", makeHandler("akuvox"));
// Akuvox empuja eventos por **Action URL = HTTP GET saliente** (no POST). Este
// handler lee los query params del Action URL, resuelve el dispositivo por IP/MAC
// y los pasa al pipeline. Auth por ?token= (requireToken ya lo valida).
router.get("/akuvox", async (req, res) => {
  maybeDump("akuvox", req);
  try {
    const q = { ...req.query, _via: "actionurl" };
    const dev = resolveDeviceByNet({ ip: q.ip || q.ipAddress, mac: q.mac });
    if (dev) { q.deviceId = dev.id; if (!q.site) q.site = dev.siteId || dev.site || undefined; }
    // Lecturas de acceso CONCEDIDO (tag/PIN/rostro/QR válidos): NO son alarmas → no van
    // a la cola. Se emiten como badge efímero al vivo + se registran (auditoría).
    if (isAkuvoxAccessRead(q)) {
      const hr = dev ? await handleAkuvoxAccessRead(q, dev) : null;
      const ar = hr && hr.ar ? hr.ar : null;
      return res.status(200).json({ ok: true, accessRead: ar ? ar.id : null, badge: !!(hr && hr.emitted), recorded: !!ar });
    }
    const event = await ingestRaw("akuvox", q, {});
    if (event === null) return res.status(202).json({ ignored: true, reason: "echo" });
    log.info(`Ingesta akuvox[actionurl]: ${event.type} → ${event.id} (p${event.priority})`);
    return res.status(201).json({ ok: true, id: event.id, type: event.type });
  } catch (err) {
    log.error(`Error en ingesta akuvox[actionurl]: ${err.message}`);
    return res.status(500).json({ error: "ingest_failed", message: err.message });
  }
});
router.post("/nvr", makeHandler("nvr"));
router.post("/alarm", makeHandler("alarm"));
// Paneles de alarma AX y controladoras de acceso DS-K. Es el destino que se
// carga en el `httpHosts` del equipo (PUT /ISAPI/Event/notification/httpHosts).
router.post("/access", makeHandler("access"));
router.post("/generic", makeHandler("generic"));

export default router;
