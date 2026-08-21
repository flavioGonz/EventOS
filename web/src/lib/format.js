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
//
// El contador cuenta HACIA ARRIBA (0:00 → límite): muestra el tiempo transcurrido
// sobre el total (p.ej. "SLA 0:45 / 2:00") y va cambiando de color a medida que se
// acerca al límite (verde → ámbar → rojo), y "SLA vencido +m:ss" al pasarse.
function fmtMMSS(ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
export function slaInfo(event) {
  if (!event || !event.slaDeadline) return null
  const total = (event.slaSeconds || 0) * 1000
  const remaining = new Date(event.slaDeadline).getTime() - Date.now()
  const breached = remaining <= 0
  const elapsed = Math.max(0, total - Math.max(0, remaining)) // tiempo transcurrido
  const frac = total > 0 ? Math.min(1, elapsed / total) : (breached ? 1 : 0)
  // Escalón de color: verde (<50%) → ámbar (50–85%) → rojo (≥85% o vencido).
  const tone = breached || frac >= 0.85 ? 'crit' : frac >= 0.5 ? 'warn' : 'ok'
  const label = breached
    ? `SLA vencido +${fmtMMSS(-remaining)}`
    : (total > 0 ? `SLA ${fmtMMSS(elapsed)} / ${fmtMMSS(total)}` : `SLA ${fmtMMSS(elapsed)}`)
  return { breached, tone, label, secs: Math.round(elapsed / 1000), frac }
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
