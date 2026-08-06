// console.js — namespace Socket.io /console (CONTRACT §4 + CONTRACT-V2 §3)
//
// Mantiene el mapeo operatorId→socketId (en dispatch/store) para emisión dirigida,
// enruta cada evento nuevo a través del motor de balanceo (routeNewEvent), y cancela
// los timers de ACK cuando el operario actúa. Conserva todos los nombres de eventos v1.
import { log } from "../logger.js";
import { bus } from "../bus/redisBus.js";
import {
  updateEvent,
  getEvent,
  listEvents,
  listSnapshot,
  queueState,
  registerOperator,
  heartbeat,
  pauseOperator,
  resumeOperator,
  incHandled,
  disconnectOperator,
  listOperators,
  operatorStats,
  registerSocket,
  removeSocket,
  socketsOf,
} from "../dispatch/store.js";
import {
  routeNewEvent,
  onOperatorAction,
  redispatchOrphans,
  releaseOperatorEvents,
  redispatchOnBoot,
  escalateToSupervisors,
} from "../dispatch/engine.js";
import { list as listConfig, getDispatch } from "../config/store.js";
import { sessionFromHandshake } from "../auth/session.js";

const QUEUE_TOP = 20;
const SNAPSHOT_LIMIT = 100;

// Construye el payload queue:state
function queuePayload() {
  const { counts, top } = queueState(QUEUE_TOP);
  return { counts, top };
}

// Adjunta el namespace /console al servidor Socket.io
export function attachConsole(io) {
  const nsp = io.of("/console");

  // Guardia de sesión: sólo operarios logueados (cookie eventos_sid) entran al
  // namespace. Sin sesión no hay snapshot ni acciones — evita que cualquiera en
  // internet escuche alarmas o resuelva eventos ajenos. La identidad la fija la
  // sesión, no el cliente. Se puede desactivar con EVENTOS_SOCKET_OPEN=1.
  nsp.use((socket, next) => {
    if (process.env.EVENTOS_SOCKET_OPEN === "1") { socket.data.session = null; return next(); }
    const s = sessionFromHandshake(socket.handshake);
    if (!s) return next(new Error("auth_required"));
    socket.data.session = s;
    next();
  });

  // No perder alertas (c): al arrancar, los activos rehidratados que estaban
  // apropiados por operarios (ya sin socket) se devuelven a la cola. Se
  // re-enrutan solos cuando el primer operario haga hello (redispatchOrphans).
  try { redispatchOnBoot(); } catch (e) { log.warn(`redispatchOnBoot: ${e.message}`); }

  // El bus alimenta los eventos nuevos: el enrutamiento (broadcast vs dirigido) lo
  // decide el motor de dispatch, que aquí dispone de `io` para emisión dirigida.
  bus.subscribe((event) => {
    try {
      routeNewEvent(event, io);
    } catch (e) {
      // Si el motor falla, no perder el evento: broadcast simple (compat v1)
      log.warn(`routeNewEvent falló (${e.message}) — broadcast simple`);
      nsp.emit("event:new", { event });
      nsp.emit("queue:state", queuePayload());
    }
  });

  // ── Barrido de SLA: auto-escala eventos cuyo plazo venció y siguen sin atender
  // (new/assigned/ack). No toca los que ya están en curso, resueltos o escalados.
  const SLA_SWEEP_MS = 15000;
  const ESCALATABLE = ["new", "assigned", "ack"];
  const slaSweep = setInterval(() => {
    try {
      const now = Date.now();
      for (const ev of listEvents({ limit: 500 })) {
        if (!ev.slaDeadline || ev.slaAutoEscalated) continue;
        if (!ESCALATABLE.includes(ev.status)) continue;
        if (new Date(ev.slaDeadline).getTime() > now) continue;
        ev.slaAutoEscalated = true;
        const disp = getDispatch();
        if (disp && disp.escalationGroupId) {
          // Escalado dirigido a supervisión (Batch C).
          escalateToSupervisors(io, ev, disp, "SLA vencido");
          log.info(`SLA vencido → escalado a supervisión ${ev.id}`);
        } else {
          const updated = updateEvent(ev.id, {
            status: "escalated",
            logEntry: { operatorId: null, operatorName: null, action: "escalate", note: "Auto-escalado: SLA vencido" },
          });
          if (updated) {
            bus.save(updated);
            nsp.emit("event:update", { event: updated });
            nsp.emit("queue:state", queuePayload());
            log.info(`SLA vencido → auto-escalado ${ev.id}`);
          }
        }
      }

      // ── Higiene de cola (Batch E): auto-cierra los `new` NUNCA atendidos que
      // superan el TTL y son de baja prioridad, para que la cola no crezca sin
      // límite. Protege prioridad alta (número menor). Opt-in (queueTtlHours>0).
      const dispTtl = getDispatch();
      const ttlH = Number(dispTtl?.queueTtlHours) || 0;
      if (ttlH > 0) {
        const minPrio = Math.min(5, Math.max(1, Number(dispTtl.queueTtlMinPriority) || 4));
        const cutoff = now - ttlH * 3600 * 1000;
        for (const ev of listEvents({ status: "new", limit: 1000 })) {
          if ((ev.priority ?? 5) < minPrio) continue; // prioridad alta → no se toca
          if (new Date(ev.ts).getTime() > cutoff) continue; // aún dentro del TTL
          const updated = updateEvent(ev.id, {
            status: "resolved",
            disposition: "auto_closed",
            logEntry: { operatorId: null, operatorName: null, action: "resolve", note: `Auto-cierre por TTL (${ttlH}h sin atender)` },
          });
          if (updated) {
            bus.save(updated);
            nsp.emit("event:update", { event: updated });
            nsp.emit("queue:state", queuePayload());
            log.info(`TTL: auto-cerrado ${ev.id} (new, prio ${ev.priority}, > ${ttlH}h)`);
          }
        }
      }
    } catch (e) {
      log.warn(`Barrido SLA: ${e.message}`);
    }
  }, SLA_SWEEP_MS);
  slaSweep.unref?.();

  nsp.on("connection", (socket) => {
    log.info(`Socket conectado: ${socket.id}`);
    // La identidad la fija la sesión (no el cliente). En modo abierto queda null.
    const session = socket.data.session || null;
    let operatorId = null;

    // Snapshot inicial del estado actual
    socket.emit("snapshot", {
      events: listSnapshot(),
      operators: listOperators(),
    });

    // Broadcast del estado de operarios a todos
    const broadcastOperators = () => nsp.emit("operators:state", { operators: listOperators() });

    // Emite operator:self {stats} a TODOS los sockets de un operario (su contador en vivo).
    const emitSelf = (id) => {
      if (!id) return;
      const stats = operatorStats(id);
      if (!stats) return;
      for (const sid of socketsOf(id)) nsp.to(sid).emit("operator:self", { stats });
    };

    // Helper: muta evento, persiste en bus y difunde update + cola.
    // Toda acción del operario cancela el timer de reasignación del evento.
    const mutate = (eventId, changes) => {
      onOperatorAction(eventId); // cancela timer de ACK pendiente
      const event = updateEvent(eventId, changes);
      if (!event) return null;
      bus.save(event); // upsert en `recent` (no bloqueante)
      nsp.emit("event:update", { event });
      nsp.emit("queue:state", queuePayload());
      return event;
    };

    // Datos del operario para la bitácora
    const actor = () => {
      const op = operatorId ? listOperators().find((o) => o.id === operatorId) : null;
      return { operatorId, operatorName: op?.name || null };
    };

    // ── Cliente → Servidor ──────────────────────────────────────────────

    socket.on("operator:hello", (payload = {}) => {
      // La identidad autoritativa es la de la sesión; el cliente sólo aporta
      // skills/nombre de display. En modo abierto se cae al id del payload.
      const id = (session && session.operatorId) || payload.operatorId;
      const name = (session && session.name) || payload.name;
      const skills = payload.skills;
      if (!id) return;
      operatorId = id;
      registerOperator({ operatorId: id, name, skills });
      registerSocket(id, socket.id); // mapeo para emisión dirigida
      // Reenvía snapshot al recién identificado
      socket.emit("snapshot", {
        events: listSnapshot(),
        operators: listOperators(),
      });
      broadcastOperators();
      emitSelf(id); // contador propio inicial
      // No perder alertas (a): ahora que hay un operario disponible, re-enrutar
      // las alarmas que habían quedado `new` sin dueño (llegaron con la consola
      // vacía, o fueron liberadas por caídas / reinicios anteriores).
      try { redispatchOrphans(io); } catch (e) { log.warn(`redispatchOrphans (hello ${id}): ${e.message}`); }
    });

    // ── Presencia: pausa / reanudar (CONTRACT-V3 §1) ─────────────────────
    socket.on("operator:pause", ({ reason } = {}) => {
      if (!operatorId) return;
      const op = pauseOperator(operatorId, reason);
      if (!op) return;
      broadcastOperators(); // todos ven el nuevo estado
      emitSelf(operatorId); // su contador en vivo
    });

    socket.on("operator:resume", () => {
      if (!operatorId) return;
      const op = resumeOperator(operatorId);
      if (!op) return;
      broadcastOperators();
      emitSelf(operatorId);
    });

    socket.on("event:claim", ({ eventId } = {}) => {
      if (!eventId || !operatorId) return;
      // Compare-and-set: solo se puede tomar si está libre o ya es tuyo. Evita la
      // doble-asignación cuando dos operarios pulsan "Tomar" casi a la vez.
      const cur = getEvent(eventId);
      if (!cur) return;
      const free = cur.status === "new" || !cur.assignedTo;
      const mineAlready = cur.assignedTo === operatorId;
      if (!free && !mineAlready) {
        socket.emit("event:claim:denied", {
          eventId,
          assignedTo: cur.assignedTo,
          message: "Este evento ya fue tomado por otro operario.",
        });
        return;
      }
      const a = actor();
      const ev = mutate(eventId, {
        status: "assigned",
        assignedTo: operatorId,
        logEntry: { ...a, action: "claim", note: "" },
      });
      if (ev) broadcastOperators();
    });

    socket.on("event:ack", ({ eventId } = {}) => {
      if (!eventId) return;
      const a = actor();
      mutate(eventId, {
        status: "ack",
        assignedTo: operatorId,
        logEntry: { ...a, action: "ack", note: "" },
      });
      broadcastOperators();
    });

    socket.on("event:progress", ({ eventId, note = "" } = {}) => {
      if (!eventId) return;
      const a = actor();
      mutate(eventId, {
        status: "in_progress",
        assignedTo: operatorId,
        logEntry: { ...a, action: "in_progress", note },
      });
    });

    socket.on("event:note", ({ eventId, note = "" } = {}) => {
      if (!eventId) return;
      const a = actor();
      mutate(eventId, { logEntry: { ...a, action: "note", note } });
    });

    socket.on("event:resolve", ({ eventId, disposition, note = "" } = {}) => {
      if (!eventId) return;
      const a = actor();
      // Tiempo de atención: desde el primer log "receive" hasta ahora (ms).
      const before = getEvent(eventId);
      let handleMs;
      if (before?.log?.length) {
        const t0 = new Date(before.log[0].ts).getTime();
        if (!Number.isNaN(t0)) handleMs = Date.now() - t0;
      }
      const ev = mutate(eventId, {
        status: "resolved",
        disposition: disposition || "no_action",
        logEntry: { ...a, action: "resolve", note },
      });
      if (ev) {
        // Contabiliza el evento resuelto a quien lo resolvió (§1).
        if (operatorId) {
          incHandled(operatorId, handleMs);
          emitSelf(operatorId);
        }
        broadcastOperators();
      }
    });

    socket.on("event:escalate", ({ eventId, note = "" } = {}) => {
      if (!eventId) return;
      const a = actor();
      mutate(eventId, {
        status: "escalated",
        logEntry: { ...a, action: "escalate", note },
      });
      broadcastOperators();
    });

    // ── Transferir el evento a un grupo de operarios (CONTRACT-V3 §1b) ────
    // Devuelve el evento a estado "new" (sin asignar) y lo notifica a los
    // miembros online del grupo para que aparezca en su consola.
    socket.on("event:transfer", ({ eventId, groupId } = {}) => {
      if (!eventId || !groupId) return;
      let group = null;
      try { group = listConfig("groups").find((g) => g.id === groupId) || null; } catch { /* store */ }
      if (!group) return;
      const a = actor();
      const ev = mutate(eventId, {
        status: "new",
        assignedTo: null,
        logEntry: { ...a, operatorName: a.operatorName || "Supervision", action: "transfer", note: `→ grupo ${group.name}` },
      });
      if (!ev) return;
      for (const id of new Set(group.operatorIds || [])) {
        for (const sid of socketsOf(id)) nsp.to(sid).emit("event:new", { event: ev });
      }
      broadcastOperators();
    });

    // ── Llamada a contacto del cliente (CONTRACT-V3 §2) ──────────────────
    // Registra en la bitácora que el operario llamó a un contacto del sitio.
    socket.on("event:call", ({ eventId, contactName, phone } = {}) => {
      if (!eventId) return;
      const a = actor();
      const who = contactName || "contacto";
      const tel = phone ? ` (${phone})` : "";
      mutate(eventId, {
        logEntry: { ...a, action: "call", note: `Llamó a ${who}${tel}` },
      });
    });

    // Heartbeat opcional para mantener lastSeen
    socket.on("operator:heartbeat", () => {
      if (operatorId) heartbeat(operatorId);
    });

    socket.on("disconnect", () => {
      log.info(`Socket desconectado: ${socket.id}`);
      if (operatorId) {
        // Sólo marcar offline si fue el último socket del operario
        const last = removeSocket(operatorId, socket.id);
        if (last) {
          disconnectOperator(operatorId);
          // No perder alertas (b): sus eventos apropiados vuelven a la cola y se
          // re-enrutan a quien quede disponible (o esperan al próximo operario).
          try { releaseOperatorEvents(io, operatorId); } catch (e) { log.warn(`releaseOperatorEvents (${operatorId}): ${e.message}`); }
        }
        broadcastOperators();
      }
    });
  });

  return nsp;
}

export default attachConsole;
