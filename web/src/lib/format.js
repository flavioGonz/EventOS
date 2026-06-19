// Utilidades de presentación compartidas entre componentes.

export const PRIORITY_LABEL = {
  1: 'Crítico',
  2: 'Alto',
  3: 'Medio',
  4: 'Bajo',
  5: 'Info',
}

export const CATEGORY_LABEL = {
  video: 'Video',
  access: 'Acceso',
  intrusion: 'Intrusión',
  system: 'Sistema',
}

export const STATUS_LABEL = {
  new: 'Nuevo',
  assigned: 'Asignado',
  ack: 'Acuse',
  in_progress: 'En curso',
  resolved: 'Resuelto',
  escalated: 'Escalado',
}

export const DISPOSITION_LABEL = {
  real: 'Real',
  false_alarm: 'Falsa alarma',
  test: 'Prueba',
  no_action: 'Sin acción',
}

export const LOG_ACTION_LABEL = {
  receive: 'Recepción',
  assign: 'Asignación',
  claim: 'Tomado',
  ack: 'Acuse',
  note: 'Nota',
  in_progress: 'En curso',
  resolve: 'Resuelto',
  escalate: 'Escalado',
  call: 'Llamada',
  transfer: 'Transferencia',
}

// Estado del SLA de un evento (a partir de slaDeadline/slaSeconds sellados en el
// server). Devuelve null si el evento no tiene SLA. tone: ok | warn | crit.
export function slaInfo(event) {
  if (!event || !event.slaDeadline) return null
  const ms = new Date(event.slaDeadline).getTime() - Date.now()
  const total = (event.slaSeconds || 0) * 1000
  const breached = ms <= 0
  const tone = breached ? 'crit' : (total && ms < total * 0.25) ? 'warn' : 'ok'
  const secs = Math.max(0, Math.round(ms / 1000))
  const mm = Math.floor(secs / 60)
  const ss = secs % 60
  const label = breached ? 'SLA vencido' : `SLA ${mm}:${String(ss).padStart(2, '0')}`
  return { breached, tone, label, secs }
}

export function priorityClass(priority) {
  const p = priority ?? 5
  if (p <= 1) return 'p1'
  if (p === 2) return 'p2'
  if (p === 3) return 'p3'
  if (p === 4) return 'p4'
  return 'p5'
}

export function timeAgo(ts) {
  if (!ts) return '—'
  const then = new Date(ts).getTime()
  if (Number.isNaN(then)) return '—'
  const diff = Math.max(0, Date.now() - then)
  const s = Math.floor(diff / 1000)
  if (s < 5) return 'ahora'
  if (s < 60) return `hace ${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `hace ${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `hace ${h}h`
  const d = Math.floor(h / 24)
  return `hace ${d}d`
}

export function formatTime(ts) {
  if (!ts) return '—'
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleTimeString('es-ES', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

export function sourceLine(event) {
  const s = (event && event.source) || {}
  const parts = []
  if (s.deviceName) parts.push(s.deviceName)
  else if (s.deviceId) parts.push(s.deviceId)
  if (s.channel !== undefined && s.channel !== null && s.channel !== '')
    parts.push(`canal ${s.channel}`)
  if (s.site) parts.push(s.site)
  return parts.join(' · ') || 'Fuente desconocida'
}
