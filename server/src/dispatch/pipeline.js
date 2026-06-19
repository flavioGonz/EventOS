// pipeline.js — pipeline compartido por ingesta y simulador (CONTRACT §3)
// normalizar → aplicar reglas (store) → persistir → publicar en bus → (socket emite + enruta)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalize } from "../events/normalize.js";
import { applyRules } from "../rules/engine.js";
import { addEvent } from "./store.js";
import { getProcedure, list as listConfig } from "../config/store.js";
import { bus } from "../bus/redisBus.js";
import { log } from "../logger.js";
import { appendJsonl, capFile } from "../util/jsonl.js";
import { digestGetBuffer } from "../util/digestFetch.js";
import { evaluateDeviceAlert } from "../alerts/policy.js";

const EVENTS_LOG = "events.jsonl";

// Evidencia: guarda la foto del evento (JPEG) en disco y devuelve su URL pública.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EVIDENCE_DIR = path.resolve(__dirname, "..", "..", "data", "evidence");
function saveEvidenceImage(eventId, image) {
  try {
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    fs.writeFileSync(path.join(EVIDENCE_DIR, `${eventId}.jpg`), image);
    return `/api/evidence/${eventId}.jpg`;
  } catch (e) {
    log.warn(`No se pudo guardar la evidencia de ${eventId} (${e.message})`);
    return null;
  }
}
// Captura el snapshot ISAPI de la cámara del evento (cuando el NVR no adjunta
// foto en la alerta). Da una imagen del momento (±1-2 s) para que el operador
// vea QUÉ pasó. Timeout corto + tolerante: si falla, el evento sigue sin foto.
async function captureDeviceSnapshot(deviceId, timeoutMs = 1800) {
  try {
    if (!deviceId) return null;
    let devices = [];
    try { devices = listConfig("devices"); } catch { return null; }
    const dev = devices.find((d) => d.id === deviceId);
    if (!dev || !dev.ip || !dev.isapiPort || !dev.username) return null;
    const ch = Number(dev.channel) > 0 ? Number(dev.channel) : 1;
    const r = await digestGetBuffer({
      host: dev.ip, port: Number(dev.isapiPort), https: !!dev.isapiHttps,
      path: `/ISAPI/Streaming/channels/${ch}01/picture`,
      user: dev.username, pass: dev.password || "", timeoutMs,
    });
    if (r.status === 200 && r.buffer && r.buffer.length > 200 && /image/i.test(r.contentType || "")) return r.buffer;
  } catch { /* tolerante */ }
  return null;
}

const EVENTS_LOG_MAX = 50 * 1024 * 1024; // ~50 MB (CONTRACT-V3 §3)

// Cada N eventos comprobamos el tamaño del archivo y recortamos si excede (barato).
let appendCount = 0;
const CAP_CHECK_EVERY = 200;

// Registra una fila de analítica de flujo (sin payload). Async, no bloquea, tolerante.
function logFlowEvent(event) {
  // Fire-and-forget: nunca await en el hot-path.
  appendJsonl(EVENTS_LOG, {
    ts: event.ts,
    type: event.type ?? null,
    category: event.category ?? null,
    priority: event.priority ?? null,
    vendor: event.source?.vendor ?? null,
    site: event.source?.site ?? null,
    status: event.status ?? null,
    target: event.target ?? null,
  });
  if (++appendCount % CAP_CHECK_EVERY === 0) {
    capFile(EVENTS_LOG, EVENTS_LOG_MAX); // recorte periódico (async, tolerante)
  }
}

// Procesa un payload crudo de un fabricante y devuelve el Event canónico creado.
// El emit por socket y el enrutamiento (motor de dispatch) ocurren porque la capa
// de socket está suscrita al bus (allí dispone de `io` para emisión dirigida).
export async function ingestRaw(vendor, raw, opts = {}) {
  const event = normalize(vendor, raw); // 1. normalizar
  const { rule } = applyRules(event); // 2. aplicar reglas (prioridad + procedimiento)
  // Guardamos la regla que casó como campo interno (no canónico) para que el
  // motor de dispatch lea actions.dispatchMode/skills/operatorIds.
  if (rule) event._rule = rule;

  // FILTRADO DE FALSAS ALARMAS (nivel 1): si la regla que casó marca "descartar"
  // (p. ej. cruce de línea sin objetivo humano/vehículo), NO se alerta al operador;
  // solo se registra en la analítica de flujo para auditoría/métricas.
  if (rule && rule.actions && rule.actions.discard) {
    event.status = "discarded";
    event.disposition = "false_alarm";
    logFlowEvent(event);
    return event;
  }

  // POLÍTICA DE ALERTADO POR DISPOSITIVO (Config › Dispositivo › Alertas):
  // qué tipos disparan, filtro por objetivo (persona/vehículo), prioridad y
  // horario. Si el dispositivo decide NO alertar, se descarta (solo analítica).
  // El evento de PRUEBA (opts.test) salta esta política para diagnosticar la cadena.
  if (!opts.test && event.source && event.source.deviceId) {
    let dev = null;
    try { dev = (listConfig("devices") || []).find((d) => d.id === event.source.deviceId); } catch { /* store */ }
    if (dev && dev.alerts) {
      const decision = evaluateDeviceAlert(dev, event);
      if (!decision.allow) {
        event.status = "discarded";
        event.disposition = "false_alarm";
        event._alertBlock = decision.reason;
        logFlowEvent(event);
        return event;
      }
      if (decision.priority) event.priority = decision.priority; // override por dispositivo
    }
  }
  // SLA: si hay procedimiento asignado, sella slaSeconds + slaDeadline (contador
  // del operador + barrido de auto-escalado).
  if (event.procedureId) {
    const proc = getProcedure(event.procedureId);
    if (proc && Number(proc.slaSeconds) > 0) {
      event.slaSeconds = Number(proc.slaSeconds);
      event.slaDeadline = new Date(new Date(event.ts).getTime() + event.slaSeconds * 1000).toISOString();
    }
  }
  // 2b. Evidencia: si llegó la foto del evento (JPEG del multipart), la guardamos.
  // Si NO llegó (los NVR de cesimco mandan alertas SIN imagen), capturamos el
  // snapshot ISAPI de la cámara del evento en ese instante. Así el operador SIEMPRE
  // ve la foto del momento en el popup y la búsqueda IA.
  let image = opts.image && opts.image.length ? opts.image : null;
  if (!image && event.source && event.source.deviceId) {
    image = await captureDeviceSnapshot(event.source.deviceId);
  }
  if (image && image.length) {
    const url = saveEvidenceImage(event.id, image);
    if (url) {
      event.media = event.media || {};
      event.media.snapshotUrl = event.media.snapshotUrl || url;
      event.media.evidenceUrl = url;
    }
  }
  addEvent(event); // 3. persistir en store
  logFlowEvent(event); // 3b. analítica de flujo → events.jsonl (no bloquea)
  await bus.publish(event); // 4. publicar en bus (→ socket: emit + routeNewEvent)
  return event;
}

export default ingestRaw;
