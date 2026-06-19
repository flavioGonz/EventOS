import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { io } from 'socket.io-client'

// --- Identidad del operario (persistida en localStorage) ---------------------

const LS_KEY = 'eventos.operator'

export function loadOperator() {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return null
    const op = JSON.parse(raw)
    if (op && op.operatorId && op.name) return op
    return null
  } catch {
    return null
  }
}

export function saveOperator(op) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(op))
  } catch {
    /* ignore */
  }
}

// --- Ordenamiento de eventos: por prioridad y luego recencia -----------------

export function sortEvents(events) {
  return [...events].sort((a, b) => {
    const pa = a.priority ?? 5
    const pb = b.priority ?? 5
    if (pa !== pb) return pa - pb
    return new Date(b.ts).getTime() - new Date(a.ts).getTime()
  })
}

function upsert(list, event) {
  const idx = list.findIndex((e) => e.id === event.id)
  if (idx === -1) return [event, ...list]
  const next = list.slice()
  next[idx] = event
  return next
}

// Alerta sonora inmediata al llegar un evento de alta prioridad (atención del
// operador sin depender de que mire la pantalla). Web Audio, sin assets; puede
// quedar en silencio hasta el primer gesto del usuario (política del navegador).
let _audioCtx = null
function playAlert(priority = 5) {
  try {
    const AC = window.AudioContext || window.webkitAudioContext
    if (!AC) return
    if (!_audioCtx) _audioCtx = new AC()
    if (_audioCtx.state === 'suspended') _audioCtx.resume()
    const ctx = _audioCtx
    const now = ctx.currentTime
    const crit = (priority ?? 5) <= 1
    const beeps = crit ? [0, 0.2] : [0] // doble bip para P1, simple para P2
    for (const t of beeps) {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = crit ? 880 : 620
      gain.gain.setValueAtTime(0.0001, now + t)
      gain.gain.exponentialRampToValueAtTime(0.25, now + t + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, now + t + 0.16)
      osc.connect(gain); gain.connect(ctx.destination)
      osc.start(now + t); osc.stop(now + t + 0.18)
    }
  } catch { /* audio bloqueado hasta gesto del usuario */ }
}

// --- Hook principal de la consola --------------------------------------------
//
// Conecta al namespace /console, mantiene el estado local desde
// snapshot / event:new / event:update / queue:state / operators:state,
// y expone emisores de acciones (claim, ack, progress, note, resolve,
// escalate, hello).

export function useConsole(operator) {
  const socketRef = useRef(null)

  const [status, setStatus] = useState('disconnected') // connecting|connected|disconnected
  const [redis, setRedis] = useState('unknown') // connected|memory|unknown
  const [events, setEvents] = useState([])
  const [operators, setOperators] = useState([])
  const [queue, setQueue] = useState({ counts: {}, top: [] })
  const [selfStats, setSelfStats] = useState(null) // contadores propios (tiempo/pausa)

  // El último evento nuevo que merece atención (para auto-abrir el popup).
  const [alertEvent, setAlertEvent] = useState(null)
  // Aviso transitorio para la consola (p. ej. "evento ya tomado por otro").
  const [notice, setNotice] = useState(null)

  // Conexión / suscripción a eventos del servidor.
  useEffect(() => {
    const socket = io('/console', {
      path: '/socket.io',
      transports: ['websocket', 'polling'],
      autoConnect: true,
    })
    socketRef.current = socket

    setStatus('connecting')

    socket.on('connect', () => {
      setStatus('connected')
      // Identificarse en cuanto haya conexión (si ya hay operario elegido).
      if (operator && operator.operatorId) {
        socket.emit('operator:hello', {
          operatorId: operator.operatorId,
          name: operator.name,
          skills: operator.skills || [],
        })
      }
    })

    socket.on('disconnect', () => setStatus('disconnected'))
    socket.on('connect_error', () => setStatus('disconnected'))

    socket.on('snapshot', ({ events: evs = [], operators: ops = [] }) => {
      setEvents(sortEvents(evs))
      setOperators(ops)
    })

    socket.on('event:new', ({ event }) => {
      if (!event) return
      setEvents((prev) => sortEvents(upsert(prev, event)))
      // Auto-alerta para prioridad alta sin asignar: abre popup + bip sonoro.
      if ((event.priority ?? 5) <= 2 && !event.assignedTo && event.status === 'new') {
        setAlertEvent(event)
        playAlert(event.priority)
      }
    })

    // El servidor rechazó un "Tomar" porque otro operario ya lo reclamó.
    socket.on('event:claim:denied', ({ message } = {}) => {
      setNotice({ tone: 'warn', text: message || 'El evento ya fue tomado por otro operario.', at: Date.now() })
    })

    socket.on('event:update', ({ event }) => {
      if (!event) return
      setEvents((prev) => sortEvents(upsert(prev, event)))
    })

    socket.on('queue:state', ({ counts = {}, top = [] }) => {
      setQueue({ counts, top })
    })

    socket.on('operators:state', ({ operators: ops = [] }) => {
      setOperators(ops)
    })

    socket.on('operator:self', ({ stats } = {}) => {
      if (stats) setSelfStats(stats)
    })

    return () => {
      socket.removeAllListeners()
      socket.disconnect()
      socketRef.current = null
    }
    // Reconectar/re-suscribir si cambia la identidad del operario.
  }, [operator && operator.operatorId, operator && operator.name])

  // Salud del bus (redis vs memoria) desde el endpoint HTTP.
  useEffect(() => {
    let alive = true
    async function poll() {
      try {
        const res = await fetch('/api/health')
        if (!res.ok) return
        const data = await res.json()
        if (alive && data && data.redis) setRedis(data.redis)
      } catch {
        /* el server puede no estar arriba aún */
      }
    }
    poll()
    const t = setInterval(poll, 15000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [])

  // --- Emisores de acciones --------------------------------------------------

  const emit = useCallback((name, payload) => {
    const s = socketRef.current
    if (s && s.connected) s.emit(name, payload)
  }, [])

  const hello = useCallback(
    (op) =>
      emit('operator:hello', {
        operatorId: op.operatorId,
        name: op.name,
        skills: op.skills || [],
      }),
    [emit]
  )

  const claim = useCallback((eventId) => emit('event:claim', { eventId }), [emit])
  const ack = useCallback((eventId) => emit('event:ack', { eventId }), [emit])
  const progress = useCallback(
    (eventId, note) => emit('event:progress', { eventId, note }),
    [emit]
  )
  const note = useCallback(
    (eventId, text) => emit('event:note', { eventId, note: text }),
    [emit]
  )
  const resolve = useCallback(
    (eventId, disposition, text) =>
      emit('event:resolve', { eventId, disposition, note: text }),
    [emit]
  )
  const escalate = useCallback(
    (eventId, text) => emit('event:escalate', { eventId, note: text }),
    [emit]
  )
  // Pausas / tiempo de operador (CONTRACT-V3 §1)
  const pause = useCallback((reason) => emit('operator:pause', { reason }), [emit])
  const resume = useCallback(() => emit('operator:resume', {}), [emit])
  // Llamada a contacto del cliente desde el popup (CONTRACT-V3 §2)
  const call = useCallback(
    (eventId, contactName, phone) => emit('event:call', { eventId, contactName, phone }),
    [emit]
  )
  // Transferir el evento a un grupo de operarios (CONTRACT-V3 §1b)
  const transfer = useCallback(
    (eventId, groupId) => emit('event:transfer', { eventId, groupId }),
    [emit]
  )

  const clearAlert = useCallback(() => setAlertEvent(null), [])
  const clearNotice = useCallback(() => setNotice(null), [])

  // Auto-descartar el aviso transitorio a los ~4.5s.
  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), 4500)
    return () => clearTimeout(t)
  }, [notice])

  // Resumen de cola para los chips (crítico/activo). Usa los conteos REALES del
  // servidor (queue:state → counts.priority['1'] y counts.total), que abarcan
  // toda la cola; cae a un cálculo local sobre `events` solo si aún no llegaron.
  const summary = useMemo(() => {
    const counts = queue.counts || {}
    const active = events.filter(
      (e) => e.status !== 'resolved' && e.status !== 'escalated'
    )
    const localCritical = active.filter((e) => (e.priority ?? 5) <= 1).length
    const srvCritical = counts.priority ? Number(counts.priority['1'] || 0) : undefined
    return {
      critical: srvCritical ?? localCritical,
      active: counts.total ?? active.length,
    }
  }, [queue, events])

  return {
    status,
    redis,
    events,
    operators,
    queue,
    summary,
    selfStats,
    alertEvent,
    clearAlert,
    notice,
    clearNotice,
    actions: { hello, claim, ack, progress, note, resolve, escalate, pause, resume, call, transfer },
  }
}

// --- Helpers HTTP del simulador ----------------------------------------------

async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  })
  if (!res.ok) throw new Error(`${url} → ${res.status}`)
  return res.json().catch(() => ({}))
}

export const sim = {
  burst: (count = 5) => postJSON('/api/sim/burst', { count }),
  start: (everyMs = 4000) => postJSON('/api/sim/start', { everyMs }),
  stop: () => postJSON('/api/sim/stop', {}),
}
