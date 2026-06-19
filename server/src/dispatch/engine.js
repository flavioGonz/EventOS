// engine.js — motor de balanceo / dispatch (CONTRACT-V2 §3)
//
// Al recibir un evento (ya normalizado + reglas aplicadas), decide a quién enrutarlo:
//   - modo efectivo (global o de la regla que casó cuando dispatch.mode === "rules")
//   - candidatos = operarios ONLINE (runtime) filtrados por operatorIds/skill y
//     descartando los saturados (maxConcurrentPerOperator)
//   - simultaneous → broadcast a candidatos (o a toda la consola si no hay filtro)
//   - sequential   → asignación dirigida a UN candidato (round_robin | least_loaded)
//                    con timer de ACK; al expirar reasigna o cae a broadcast
//   - sin candidatos → queda `new` y broadcast (fallback)
//
// El socket layer provee `io` y mantiene operatorId→socketId en dispatch/store.
// Cancela timers al recibir ack/claim/resolve/escalate (onOperatorAction).

import { log } from "../logger.js";
import { getDispatch, list as listConfig } from "../config/store.js";
import {
  updateEvent,
  selectCandidates,
  socketsOf,
  availableOperators,
  queueState,
} from "./store.js";
import { bus } from "../bus/redisBus.js";

const NSP = "/console";
const QUEUE_TOP = 20;

// Timers de ACK pendientes por eventId
const ackTimers = new Map();
// Round-robin: índice rotatorio por "clave de cola" (global aquí)
let rrIndex = 0;

function clearAckTimer(eventId) {
  const t = ackTimers.get(eventId);
  if (t) {
    clearTimeout(t.handle);
    ackTimers.delete(eventId);
  }
}

// Emite a toda la consola
function emitAll(io, ev, payload) {
  io.of(NSP).emit(ev, payload);
}

// Emite dirigido a un operario (todos sus sockets)
function emitTo(io, operatorId, ev, payload) {
  const nsp = io.of(NSP);
  for (const sid of socketsOf(operatorId)) nsp.to(sid).emit(ev, payload);
}

function emitQueue(io) {
  const { counts, top } = queueState(QUEUE_TOP);
  emitAll(io, "queue:state", { counts, top });
}

// Modo efectivo: si global === "rules", usa el dispatchMode de la regla que casó
function effectiveMode(event, dispatch) {
  if (dispatch.mode === "rules") {
    return event._rule?.actions?.dispatchMode || "simultaneous";
  }
  return dispatch.mode || "simultaneous";
}

// Política de despacho EFECTIVA = global + overrides de la regla que casó.
// La regla puede afinar el reparto en `actions.dispatch` (solo claves definidas).
const DISPATCH_OVERRIDE_KEYS = [
  "sequentialStrategy", "ackTimeoutSeconds", "reassignOnTimeout",
  "maxConcurrentPerOperator", "skillRouting",
];
function effectiveDispatch(event, dispatch) {
  const ov = event._rule?.actions?.dispatch;
  if (!ov || typeof ov !== "object") return dispatch;
  const out = { ...dispatch };
  for (const k of DISPATCH_OVERRIDE_KEYS) {
    if (ov[k] !== undefined && ov[k] !== null && ov[k] !== "") out[k] = ov[k];
  }
  return out;
}

// Opciones de selección de candidatos a partir de la regla + política.
// Si la regla apunta a grupos (actions.groupIds), se expanden a sus miembros
// (union de operatorIds) y se suman las skills propias de cada grupo.
function candidateOpts(event, dispatch) {
  const actions = event._rule?.actions || {};
  let operatorIds = [...(actions.operatorIds || [])];
  let skills = [...(actions.skills || [])];
  const groupIds = actions.groupIds || [];
  if (groupIds.length) {
    let groups = [];
    try { groups = listConfig("groups"); } catch { /* store no disponible */ }
    for (const gid of groupIds) {
      const g = groups.find((x) => x.id === gid);
      if (!g) continue;
      operatorIds.push(...(g.operatorIds || []));
      skills.push(...(g.skills || []));
    }
  }
  return {
    operatorIds: [...new Set(operatorIds)],
    skills: [...new Set(skills)],
    skillRouting: dispatch.skillRouting !== false,
    maxConcurrentPerOperator: dispatch.maxConcurrentPerOperator ?? Infinity,
  };
}

// ── Asignación dirigida (sequential) ────────────────────────────────────────

// Elige el siguiente candidato según la estrategia. `candidates` ya viene ordenado
// por carga asc. Para round_robin rotamos sobre el conjunto.
function pickOne(candidates, strategy) {
  if (candidates.length === 0) return null;
  if (strategy === "round_robin") {
    const op = candidates[rrIndex % candidates.length];
    rrIndex = (rrIndex + 1) % Math.max(1, candidates.length);
    return op;
  }
  // least_loaded (default): el primero (menor carga)
  return candidates[0];
}

// Asigna el evento a `operatorId`, notifica y arma el timer de ACK.
// `tried` acumula los operarios ya intentados (para reasignación).
function assignTo(io, event, operatorId, dispatch, tried) {
  const updated = updateEvent(event.id, {
    status: "assigned",
    assignedTo: operatorId,
    logEntry: { operatorId: null, operatorName: null, action: "assign", note: `→ ${operatorId}` },
  });
  if (!updated) return;
  updated._rule = event._rule; // preservar regla interna
  bus.save(updated);

  // event:new dirigido al elegido + event:assigned (resaltado "es tuyo")
  emitTo(io, operatorId, "event:new", { event: updated });
  emitTo(io, operatorId, "event:assigned", { event: updated, operatorId });
  // event:update al resto de la consola (ven que está asignado)
  emitAll(io, "event:update", { event: updated });
  emitQueue(io);

  armAckTimer(io, updated, operatorId, dispatch, tried);
}

// Arma el timer de ACK: si no hay respuesta a tiempo y reassignOnTimeout, reasigna.
function armAckTimer(io, event, operatorId, dispatch, tried) {
  clearAckTimer(event.id);
  const secs = Number(dispatch.ackTimeoutSeconds) || 0;
  if (secs <= 0 || dispatch.reassignOnTimeout === false) return;

  const handle = setTimeout(() => {
    ackTimers.delete(event.id);
    onAckTimeout(io, event.id, operatorId, dispatch, tried);
  }, secs * 1000);
  handle.unref?.();
  ackTimers.set(event.id, { handle, operatorId, tried });
}

// Expiró el ACK: log de reassign + intentar el siguiente candidato; si se agotan, broadcast.
function onAckTimeout(io, eventId, operatorId, dispatch, tried) {
  const ev = updateEvent(eventId, {
    logEntry: { operatorId: null, operatorName: null, action: "reassign", note: `timeout ${operatorId}` },
  });
  if (!ev) return;
  // Si ya dejó de estar asignado (alguien actuó), no reasignar
  if (ev.status !== "assigned") return;

  const nextTried = new Set(tried);
  nextTried.add(operatorId);

  const opts = candidateOpts(ev, dispatch);
  const candidates = selectCandidates(ev, opts).filter((op) => !nextTried.has(op.id));
  const strategy = dispatch.sequentialStrategy || "least_loaded";
  const next = pickOne(candidates, strategy);

  if (next) {
    log.info(`Reasignando ${eventId}: ${operatorId} → ${next.id} (ack timeout)`);
    assignTo(io, ev, next.id, dispatch, nextTried);
  } else {
    // Candidatos agotados → caer a broadcast
    log.info(`Sin más candidatos para ${eventId} — broadcast (fallback)`);
    const updated = updateEvent(eventId, {
      status: "new",
      assignedTo: null,
      logEntry: { operatorId: null, operatorName: null, action: "assign", note: "broadcast fallback" },
    });
    if (updated) {
      updated._rule = ev._rule;
      bus.save(updated);
      emitAll(io, "event:new", { event: updated });
      emitQueue(io);
    }
  }
}

// ── API pública ──────────────────────────────────────────────────────────────

// Enruta un evento nuevo. Llamado por la capa de socket (suscrita al bus) que tiene `io`.
export function routeNewEvent(event, io) {
  const base = getDispatch();
  const dispatch = effectiveDispatch(event, base);   // global + overrides de la regla
  const mode = effectiveMode(event, base);
  const opts = candidateOpts(event, dispatch);
  const hasFilter = (opts.operatorIds && opts.operatorIds.length > 0) || opts.skillRouting;
  const candidates = selectCandidates(event, opts);

  // Sin nadie DISPONIBLE (todos offline o en pausa) → fallback broadcast a toda
  // la consola (queda `new`, sin asignar). Los pausados ven el evento pero no se
  // les asigna (§1).
  if (availableOperators().length === 0) {
    emitAll(io, "event:new", { event });
    emitQueue(io);
    return;
  }

  if (mode === "sequential") {
    if (candidates.length === 0) {
      // Sin candidatos elegibles → broadcast fallback
      emitAll(io, "event:new", { event });
      emitQueue(io);
      return;
    }
    const strategy = dispatch.sequentialStrategy || "least_loaded";
    const chosen = pickOne(candidates, strategy);
    assignTo(io, event, chosen.id, dispatch, new Set());
    return;
  }

  // simultaneous (y "rules" que resuelva a simultaneous)
  if (opts.operatorIds && opts.operatorIds.length > 0 && candidates.length > 0) {
    // Filtro fijo de operarios: dirigido a ese subconjunto
    for (const op of candidates) emitTo(io, op.id, "event:new", { event });
    // El resto ve un update (existe en cola) — opcional; emitimos queue
    emitQueue(io);
  } else if (hasFilter && opts.skillRouting && candidates.length > 0 && candidates.length < availableOperators().length) {
    // Skill routing redujo el conjunto: dirigir sólo a los candidatos
    for (const op of candidates) emitTo(io, op.id, "event:new", { event });
    emitQueue(io);
  } else {
    // Sin filtro efectivo → broadcast a toda la consola
    emitAll(io, "event:new", { event });
    emitQueue(io);
  }
}

// El operario actuó sobre el evento (ack/claim/progress/resolve/escalate):
// cancelar cualquier timer de reasignación pendiente.
export function onOperatorAction(eventId) {
  clearAckTimer(eventId);
}

export default { routeNewEvent, onOperatorAction };
