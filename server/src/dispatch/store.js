// store.js — estado autoritativo en memoria: eventos activos + operarios
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "../logger.js";
import { appendJsonl } from "../util/jsonl.js";

const ACTIVE_STATUSES = ["new", "assigned", "ack", "in_progress", "escalated"];
const RESOLVED_CAP = 200;

// Persistencia de eventos en disco: sobreviven a reinicios de eventos-api
// (la cola en vivo no se pierde). Escritura atómica (.tmp + rename), debounced.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "..", "..", "data");
const EVENTS_FILE = path.join(DATA_DIR, "events.json");

// Motivos de pausa válidos (CONTRACT-V3 §1). Cualquier otro cae a "otro".
const PAUSE_REASONS = ["descanso", "almuerzo", "capacitacion", "bano", "otro"];
const OPERATOR_LOG = "operator-log.jsonl";

// Mapa de eventos activos (id → Event)
const active = new Map();
// Eventos resueltos recientes (cola acotada)
const resolved = [];
// Mapa de operarios conectados (operatorId → Operator)
const operators = new Map();
// Mapa operatorId → Set<socketId> para emisión dirigida (CONTRACT-V2 §3)
const sockets = new Map();

const nowIso = () => new Date().toISOString();

// ── Persistencia de eventos ─────────────────────────────────────────────────
let persistTimer = null;
function persistNow() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const doc = { savedAt: nowIso(), active: [...active.values()], resolved: resolved.slice(0, RESOLVED_CAP) };
    const tmp = EVENTS_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(doc), "utf8");
    fs.renameSync(tmp, EVENTS_FILE);
  } catch (e) {
    log.warn(`No se pudieron persistir eventos (${e.message})`);
  }
}
function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => { persistTimer = null; persistNow(); }, 1000);
  persistTimer.unref?.();
}
// Rehidrata el estado al arrancar (activos + resueltos recientes). A prueba de fallos.
function loadEvents() {
  try {
    if (!fs.existsSync(EVENTS_FILE)) return;
    const doc = JSON.parse(fs.readFileSync(EVENTS_FILE, "utf8"));
    if (Array.isArray(doc?.active)) for (const e of doc.active) if (e && e.id) active.set(e.id, e);
    if (Array.isArray(doc?.resolved)) for (const e of doc.resolved) if (e && e.id) resolved.push(e);
    if (resolved.length > RESOLVED_CAP) resolved.length = RESOLVED_CAP;
    log.info(`Eventos rehidratados desde disco: ${active.size} activos, ${resolved.length} resueltos`);
  } catch (e) {
    log.warn(`No se pudieron cargar eventos persistidos (${e.message}) — se arranca vacío`);
  }
}
loadEvents();
// Flush final en apagado para no perder el último write debounced.
process.once("SIGTERM", persistNow);
process.once("SIGINT", persistNow);

// ── Eventos ────────────────────────────────────────────────────────────────

// Añade un evento nuevo al estado activo
export function addEvent(event) {
  active.set(event.id, event);
  schedulePersist();
  return event;
}

// Recupera por id (busca en activos y resueltos)
export function getEvent(id) {
  return active.get(id) || resolved.find((e) => e.id === id) || null;
}

// Append a la bitácora
function appendLog(event, { operatorId = null, operatorName = null, action, note = "" }) {
  event.log.push({ ts: nowIso(), operatorId, operatorName, action, note });
}

// Mueve un evento resuelto fuera de los activos
function retire(event) {
  active.delete(event.id);
  resolved.unshift(event);
  if (resolved.length > RESOLVED_CAP) resolved.length = RESOLVED_CAP;
}

// Actualiza estado/asignación de un evento + log. Devuelve el evento o null.
export function updateEvent(id, { status, assignedTo, disposition, logEntry } = {}) {
  const event = getEvent(id);
  if (!event) return null;

  if (assignedTo !== undefined) event.assignedTo = assignedTo;
  if (disposition !== undefined) event.disposition = disposition;
  if (logEntry) appendLog(event, logEntry);
  if (status !== undefined) {
    event.status = status;
    if (status === "resolved" && active.has(id)) retire(event);
  }
  schedulePersist();
  return event;
}

// Lista de eventos (más recientes primero), filtrable por status, con límite.
export function listEvents({ status, limit = 50 } = {}) {
  let all = [...active.values(), ...resolved];
  if (status) all = all.filter((e) => e.status === status);
  // ordenar por ts descendente
  all.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  return all.slice(0, limit);
}

// Conteos de cola por status y por prioridad (solo activos) + top N activos
export function queueState(top = 20) {
  const counts = { status: {}, priority: {}, total: 0 };
  const list = [...active.values()];
  for (const e of list) {
    counts.status[e.status] = (counts.status[e.status] || 0) + 1;
    counts.priority[e.priority] = (counts.priority[e.priority] || 0) + 1;
    counts.total++;
  }
  // top: activos ordenados por prioridad asc (1=crítico) y luego por ts desc
  const sorted = list.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.ts < b.ts ? 1 : -1;
  });
  return { counts, top: sorted.slice(0, top) };
}

// ── Operarios ────────────────────────────────────────────────────────────

// Carga de un operario = nº de eventos activos asignados a él
export function operatorLoad(operatorId) {
  let n = 0;
  for (const e of active.values()) {
    if (e.assignedTo === operatorId && ACTIVE_STATUSES.includes(e.status)) n++;
  }
  return n;
}

// ── Presencia / pausa / tiempo contabilizado (CONTRACT-V3 §1) ───────────────
//
// Cada operario online acumula tiempo en `available` y `paused`. El acumulador
// se actualiza con el delta desde el último cambio de estado (`stateSince`).
//
// Estados: "available" | "paused" | "offline".

// Apunta a operator-log.jsonl. Tolerante (appendJsonl nunca lanza).
function logOperatorEvent(op, event, extra = {}) {
  appendJsonl(OPERATOR_LOG, {
    ts: nowIso(),
    operatorId: op?.id ?? null,
    name: op?.name ?? null,
    event,
    ...extra,
  });
}

// Normaliza un motivo de pausa al catálogo permitido.
function normalizeReason(reason) {
  const r = String(reason || "").trim().toLowerCase();
  return PAUSE_REASONS.includes(r) ? r : "otro";
}

// Acumula el tiempo transcurrido desde el último cambio de estado en el contador
// correspondiente al estado ACTUAL, y reinicia el marcador de tiempo a `at`.
function accrue(op, at = Date.now()) {
  if (!op || !op.stateSince) {
    if (op) op.stateSince = at;
    return;
  }
  const delta = Math.max(0, at - op.stateSince);
  if (op.status === "available") op.msAvailable += delta;
  else if (op.status === "paused") op.msPaused += delta;
  op.stateSince = at;
}

// Registra (o re-registra) un operario y lo marca disponible.
// En el primer hello de la sesión fija sessionStart e inicializa acumuladores.
export function registerOperator({ operatorId, name, skills = [] }) {
  const existing = operators.get(operatorId);
  const now = Date.now();
  // Si ya estaba online (otro socket), sólo refrescar datos y lastSeen.
  if (existing && existing.status !== "offline") {
    if (name) existing.name = name;
    if (skills.length) existing.skills = skills;
    existing.lastSeen = nowIso();
    existing.load = operatorLoad(operatorId);
    return existing;
  }
  // Nueva sesión (alta o reconexión tras offline).
  const op = {
    id: operatorId,
    name: name || existing?.name || operatorId,
    skills: skills.length ? skills : existing?.skills || [],
    online: true,
    status: "available",
    pauseReason: null,
    load: operatorLoad(operatorId),
    sessionStart: nowIso(),
    msAvailable: 0,
    msPaused: 0,
    pauseSince: null,
    handled: 0,
    lastSeen: nowIso(),
    stateSince: now, // marcador interno para el delta de acumulación
  };
  operators.set(operatorId, op);
  logOperatorEvent(op, "login");
  log.info(`Operario registrado: ${op.id} (${op.name})`);
  return op;
}

export function heartbeat(operatorId) {
  const op = operators.get(operatorId);
  if (op) {
    op.lastSeen = nowIso();
    // Al resucitar de offline reiniciamos el marcador para no contar el tiempo
    // offline como disponible.
    if (op.status === "offline") { op.status = "available"; op.stateSince = Date.now(); }
    op.online = true;
  }
  return op;
}

// Marca al operario en pausa con motivo. Acumula el tiempo disponible previo.
export function pauseOperator(operatorId, reason) {
  const op = operators.get(operatorId);
  if (!op || op.status === "offline") return null;
  accrue(op); // cierra el tramo "available" anterior
  const r = normalizeReason(reason);
  op.status = "paused";
  op.pauseReason = r;
  op.pauseSince = nowIso();
  op.lastSeen = nowIso();
  logOperatorEvent(op, "pause", { reason: r });
  return op;
}

// Reanuda al operario (vuelve a disponible). Acumula el tiempo en pausa y
// registra los ms de la pausa que termina.
export function resumeOperator(operatorId) {
  const op = operators.get(operatorId);
  if (!op || op.status === "offline") return null;
  const at = Date.now();
  const pausedMs = op.pauseSince ? Math.max(0, at - new Date(op.pauseSince).getTime()) : 0;
  accrue(op, at); // cierra el tramo "paused" anterior
  const reason = op.pauseReason;
  op.status = "available";
  op.pauseReason = null;
  op.pauseSince = null;
  op.lastSeen = nowIso();
  logOperatorEvent(op, "resume", { reason, ms: pausedMs });
  return op;
}

// Incrementa el contador de eventos resueltos por el operario y lo persiste.
// `ms` opcional: tiempo de atención del evento (para el tiempo medio).
export function incHandled(operatorId, ms) {
  const op = operators.get(operatorId);
  if (!op) return null;
  op.handled = (op.handled || 0) + 1;
  op.lastSeen = nowIso();
  logOperatorEvent(op, "handled", ms != null ? { ms: Math.max(0, Math.round(ms)) } : {});
  return op;
}

// Cierre de sesión: acumula el último tramo, marca offline y persiste el logout
// con el total disponible/pausa de la sesión.
export function disconnectOperator(operatorId) {
  const op = operators.get(operatorId);
  if (!op) return null;
  accrue(op); // cierra el tramo actual
  // Si se desconecta en pausa, también cerramos esa pausa en el contador.
  op.online = false;
  op.status = "offline";
  op.pauseReason = null;
  op.pauseSince = null;
  op.lastSeen = nowIso();
  logOperatorEvent(op, "logout", { ms: Math.round(op.msAvailable || 0) });
  return op;
}

// Proyección pública de un operario (sin el marcador interno stateSince).
function publicOperator(op) {
  const { stateSince, ...rest } = op;
  return { ...rest, load: operatorLoad(op.id) };
}

// Lista de operarios con carga recalculada (campos de presencia incluidos).
export function listOperators() {
  return [...operators.values()].map(publicOperator);
}

export function getOperator(operatorId) {
  const op = operators.get(operatorId);
  if (!op) return null;
  return publicOperator(op);
}

// Stats en vivo de un operario para el payload `operator:self`. Calcula los
// acumuladores "al instante" (incluyendo el tramo en curso) sin mutar el estado.
export function operatorStats(operatorId) {
  const op = operators.get(operatorId);
  if (!op) return null;
  const now = Date.now();
  const delta = op.stateSince ? Math.max(0, now - op.stateSince) : 0;
  let msAvailable = op.msAvailable || 0;
  let msPaused = op.msPaused || 0;
  if (op.status === "available") msAvailable += delta;
  else if (op.status === "paused") msPaused += delta;
  return {
    id: op.id,
    name: op.name,
    status: op.status,
    pauseReason: op.pauseReason,
    sessionStart: op.sessionStart,
    pauseSince: op.pauseSince,
    msAvailable: Math.round(msAvailable),
    msPaused: Math.round(msPaused),
    handled: op.handled || 0,
    load: operatorLoad(op.id),
    lastSeen: op.lastSeen,
  };
}

// ── Mapeo operatorId → socketId(s) (para emisión dirigida) ──────────────────

// Registra un socket para un operario
export function registerSocket(operatorId, socketId) {
  if (!operatorId || !socketId) return;
  let set = sockets.get(operatorId);
  if (!set) {
    set = new Set();
    sockets.set(operatorId, set);
  }
  set.add(socketId);
}

// Quita un socket; devuelve true si el operario ya no tiene sockets (quedó offline)
export function removeSocket(operatorId, socketId) {
  const set = sockets.get(operatorId);
  if (!set) return true;
  set.delete(socketId);
  if (set.size === 0) {
    sockets.delete(operatorId);
    return true;
  }
  return false;
}

// Socket ids de un operario (array, puede estar vacío)
export function socketsOf(operatorId) {
  const set = sockets.get(operatorId);
  return set ? [...set] : [];
}

// ¿El operario está online (tiene al menos un socket)?
export function isOnline(operatorId) {
  const set = sockets.get(operatorId);
  return !!(set && set.size > 0);
}

// Operarios online (con al menos un socket conectado), con carga recalculada.
// `online` incluye disponibles Y en pausa (siguen conectados); el filtrado de
// pausados para dispatch ocurre en selectCandidates.
export function onlineOperators() {
  const out = [];
  for (const id of sockets.keys()) {
    const op = operators.get(id);
    if (op) out.push({ ...publicOperator(op), online: true });
  }
  return out;
}

// Operarios DISPONIBLES para dispatch: online + status === "available".
export function availableOperators() {
  return onlineOperators().filter((op) => op.status === "available");
}

// ── Selección de candidatos para dispatch (CONTRACT-V2 §3) ──────────────────
//
// Devuelve los operarios online elegibles para un evento:
//  - si `operatorIds` está fijado → sólo esos (intersección con online)
//  - si no y `skillRouting` → los que tengan alguna skill que matchee las skills
//    requeridas (de la regla) o, en su defecto, la category/type del evento
//  - se descartan los que alcanzaron `maxConcurrentPerOperator`
// El orden final es por carga asc (least_loaded-friendly), luego lastSeen asc.
export function selectCandidates(event, { operatorIds = [], skills = [], skillRouting = true, maxConcurrentPerOperator = Infinity } = {}) {
  // Sólo disponibles: los operarios en `paused`/`offline` quedan EXCLUIDOS (§1).
  let pool = availableOperators();

  const hasFixed = Array.isArray(operatorIds) && operatorIds.length > 0;
  if (hasFixed) {
    // Asignación fija por regla/grupo: sólo esos operarios (si están online)
    pool = pool.filter((op) => operatorIds.includes(op.id));
  }
  if (skillRouting) {
    // Skills requeridas: las explícitas (regla/grupo) o, si NO hay operarios fijos,
    // las derivadas del evento (category + type). Con operarios fijos solo se aplican
    // skills explícitas (p. ej. las propias de un grupo), no las del evento.
    const required = (skills && skills.length
      ? skills
      : (hasFixed ? [] : [event.category, event.type])
    ).filter(Boolean);
    if (required.length > 0) {
      const filtered = pool.filter((op) => (op.skills || []).some((s) => required.includes(s)));
      // Sólo aplicar si deja a alguien; si no, no restringir por skill
      if (filtered.length > 0) pool = filtered;
    }
  }

  // Descartar saturados
  pool = pool.filter((op) => operatorLoad(op.id) < maxConcurrentPerOperator);

  // Orden estable: menor carga primero, luego visto hace más tiempo (round-robin friendly)
  pool.sort((a, b) => {
    if (a.load !== b.load) return a.load - b.load;
    return a.lastSeen < b.lastSeen ? -1 : a.lastSeen > b.lastSeen ? 1 : 0;
  });
  return pool;
}

export default {
  addEvent,
  getEvent,
  updateEvent,
  listEvents,
  queueState,
  registerOperator,
  heartbeat,
  pauseOperator,
  resumeOperator,
  incHandled,
  disconnectOperator,
  listOperators,
  getOperator,
  operatorStats,
  operatorLoad,
  registerSocket,
  removeSocket,
  socketsOf,
  isOnline,
  onlineOperators,
  availableOperators,
  selectCandidates,
};
