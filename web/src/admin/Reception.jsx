// Recepción en vivo — eventos entrando en tiempo real, manejables desde el admin.
// Reusa el socket de consola (solo lectura de la cola) + EventPopup en modo
// supervisión (ver detalle, resolver, reasignar) sin impersonar a un operario.
import { useEffect, useMemo, useState } from 'react'
import { useConsole } from '../lib/socket.js'
import { Icon, PriorityDot, StatusDot, Badge, EmptyState } from '../ui/primitives.jsx'
import { PageHead, SectionHelp } from './_shared.jsx'
import { eventTypeLabel, statusLabel, priorityLabel } from '../lib/labels.js'
import EventPopup from '../components/EventPopup.jsx'

const isActive = (e) => e.status !== 'resolved' && e.status !== 'discarded'
const fmtAge = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); if (s < 60) return `${s}s`; const m = Math.floor(s / 60); if (m < 60) return `${m}m`; return `${Math.floor(m / 60)}h ${m % 60}m` }
const fmtClock = (ts) => { try { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) } catch { return '—' } }
const STATUS_TONE = { new: 'warn', assigned: 'info', ack: 'info', in_progress: 'info', escalated: 'crit' }

function Kpi({ icon, label, value, tone }) {
  return (
    <div className={`sup-kpi${tone ? ` sup-kpi--${tone}` : ''}`}>
      <span className="sup-kpi__icon"><Icon name={icon} size={18} /></span>
      <div className="sup-kpi__body">
        <strong className="sup-kpi__val tnum">{value}</strong>
        <span className="sup-kpi__lbl">{label}</span>
      </div>
    </div>
  )
}

export default function Reception() {
  const { events, operators, status, actions } = useConsole(null)
  const [now, setNow] = useState(Date.now())
  const [openId, setOpenId] = useState(null)
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t) }, [])

  const opName = useMemo(() => Object.fromEntries((operators || []).map((o) => [o.id, o.name])), [operators])
  const byId = useMemo(() => Object.fromEntries((events || []).map((e) => [e.id, e])), [events])
  const active = useMemo(() => (events || []).filter(isActive), [events])
  const sorted = useMemo(() => [...active].sort((a, b) => (a.priority ?? 5) - (b.priority ?? 5) || (Date.parse(b.ts) - Date.parse(a.ts))), [active])
  const unattended = active.filter((e) => !e.assignedTo && e.status === 'new')
  const slaRisk = active.filter((e) => e.slaDeadline && Date.parse(e.slaDeadline) - now > 0 && Date.parse(e.slaDeadline) - now < 120000)
  const slaBreached = active.filter((e) => e.slaDeadline && now > Date.parse(e.slaDeadline) && e.status !== 'resolved')
  const online = (operators || []).filter((o) => o.online)
  const openEvent = openId ? byId[openId] || null : null

  return (
    <div className="anim-rise recep-live">
      <PageHead title="Recepción en vivo" subtitle="Alarmas entrando en tiempo real. Abrí una para ver el detalle, resolver o reasignar."
        actions={
          <span className={`recep-live__conn recep-live__conn--${status}`}>
            <StatusDot tone={status === 'connected' ? 'ok' : 'warn'} label={status === 'connected' ? 'En vivo' : 'Reconectando'} />
            {status === 'connected' ? 'En vivo' : 'Reconectando…'}
          </span>
        } />

      <SectionHelp id="recep-live" icon="reception" title="Recepción de alarmas en vivo">
        Esta vista muestra la cola de eventos tal como la ven los operadores, en tiempo real. Priorizada (1 = crítico arriba), con su estado, a quién está asignada y hace cuánto llegó. Hacé clic en cualquier evento para abrir su ficha: ver la evidencia y la bitácora, <b>resolverlo</b> o <b>reasignarlo</b> a un grupo — todo desde el admin, sin tener que tomar el evento como operario.
      </SectionHelp>

      <div className="recep-live__kpis">
        <Kpi icon="bell" label="Activos" value={active.length} />
        <Kpi icon="clock" label="Sin atender" value={unattended.length} tone={unattended.length ? 'warn' : undefined} />
        <Kpi icon="alert" label="SLA en riesgo" value={slaRisk.length} tone={slaRisk.length ? 'warn' : undefined} />
        <Kpi icon="alert" label="SLA vencido" value={slaBreached.length} tone={slaBreached.length ? 'crit' : undefined} />
        <Kpi icon="users" label="Operarios online" value={online.length} />
      </div>

      {sorted.length === 0 ? (
        <EmptyState icon="reception" title="Sin eventos activos">Cuando entre una alarma aparece acá al instante.</EmptyState>
      ) : (
        <div className="recep-live__table" role="table" aria-label="Eventos activos">
          <div className="recep-live__row recep-live__row--head" role="row">
            <span>Prioridad</span><span>Evento</span><span>Sitio / zona</span><span>Estado</span><span>Asignado a</span><span className="ta-r">Edad</span>
          </div>
          {sorted.map((e) => {
            const age = fmtAge(now - Date.parse(e.ts))
            const breached = e.slaDeadline && now > Date.parse(e.slaDeadline) && e.status !== 'resolved'
            return (
              <button type="button" role="row" key={e.id} className={`recep-live__row${breached ? ' is-breached' : ''}`} onClick={() => setOpenId(e.id)}>
                <span className="recep-live__prio"><PriorityDot p={e.priority ?? 5} /> <span className="tnum">P{e.priority ?? 5}</span></span>
                <span className="recep-live__ev">
                  <b>{eventTypeLabel(e.type)}</b>
                  <span className="recep-live__clock"><Icon name="clock" size={11} /> {fmtClock(e.ts)}</span>
                </span>
                <span className="recep-live__site">{(e.source && e.source.site) || '—'}{e.source && e.source.zone ? ` · ${e.source.zone}` : ''}</span>
                <span><Badge tone={STATUS_TONE[e.status] || 'neutral'}>{statusLabel(e.status)}</Badge></span>
                <span className="recep-live__op">{e.assignedTo ? (opName[e.assignedTo] || e.assignedTo) : <span className="muted">— sin asignar</span>}</span>
                <span className={`recep-live__age ta-r tnum${breached ? ' is-breached' : ''}`}>{age}</span>
              </button>
            )
          })}
        </div>
      )}

      {openEvent && <EventPopup event={openEvent} operator={null} actions={actions} supervise onClose={() => setOpenId(null)} />}
    </div>
  )
}
