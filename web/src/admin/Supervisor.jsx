// Panel de Supervisor — vista de mando en tiempo real del centro de monitoreo.
// KPIs en vivo, tablero de operadores (carga/estado/atendidos), cola priorizada
// con edad y cuenta regresiva de SLA, y monitor de SLA en riesgo/vencido.
import { useEffect, useMemo, useState } from 'react'
import { useConsole } from '../lib/socket.js'
import { Icon, PriorityDot, StatusDot } from '../ui/primitives.jsx'
import { PageHead, SectionHelp } from './_shared.jsx'

const fmtAge = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}
const PRIO_LBL = { 1: 'Crítico', 2: 'Alto', 3: 'Medio', 4: 'Bajo', 5: 'Info' }
const isActive = (e) => e.status !== 'resolved' && e.status !== 'escalated' && e.status !== 'discarded'

function Kpi({ icon, label, value, tone, sub }) {
  return (
    <div className={`sup-kpi${tone ? ` sup-kpi--${tone}` : ''}`}>
      <span className="sup-kpi__icon"><Icon name={icon} size={18} /></span>
      <div className="sup-kpi__body">
        <strong className="sup-kpi__val tnum">{value}</strong>
        <span className="sup-kpi__lbl">{label}</span>
        {sub != null && <span className="sup-kpi__sub">{sub}</span>}
      </div>
    </div>
  )
}

export default function Supervisor() {
  const { events, operators, summary, status } = useConsole(null)
  const [now, setNow] = useState(Date.now())
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t) }, [])

  const opName = useMemo(() => Object.fromEntries((operators || []).map((o) => [o.id, o.name])), [operators])

  const active = useMemo(() => (events || []).filter(isActive), [events])
  const unattended = active.filter((e) => !e.assignedTo && e.status === 'new')
  const oldest = unattended.reduce((a, e) => Math.min(a, Date.parse(e.ts)), Infinity)
  const slaRisk = active.filter((e) => e.slaDeadline && Date.parse(e.slaDeadline) - now > 0 && Date.parse(e.slaDeadline) - now < 120000)
  const slaBreached = active.filter((e) => e.slaDeadline && now > Date.parse(e.slaDeadline) && e.status !== 'resolved')
  const critical = (summary && summary.critical) ?? active.filter((e) => (e.priority ?? 5) <= 1).length

  const online = (operators || []).filter((o) => o.online)
  const avail = online.filter((o) => o.status !== 'paused')
  const paused = online.filter((o) => o.status === 'paused')

  // Tablero de operadores: ordenado por carga (más cargado primero).
  const opRows = useMemo(() => [...online].sort((a, b) => (b.load || 0) - (a.load || 0)), [online])

  // Cola priorizada (ya viene ordenada por prioridad+recencia desde el hook).
  const queue = active

  const slaCountdown = (e) => {
    if (!e.slaDeadline) return null
    const d = Date.parse(e.slaDeadline) - now
    return d
  }

  return (
    <div className="anim-rise sup">
      <PageHead title="Panel de Supervisor"
        subtitle={`Mando en tiempo real del centro de monitoreo · ${status === 'connected' ? 'en vivo' : 'reconectando…'}`} />

      <SectionHelp id="supervisor" icon="gauge" title="Panel de mando del turno">
        Vista en tiempo real para el supervisor: eventos críticos y activos, eventos sin atender y su antigüedad, SLA en riesgo o vencido, y la carga de cada operario conectado. Usalo para vigilar el pulso del centro y detectar cuellos de botella antes de que se conviertan en un SLA vencido.
      </SectionHelp>

      <div className="sup-kpis">
        <Kpi icon="siren" label="Críticos (P1)" value={critical} tone={critical > 0 ? 'crit' : null} />
        <Kpi icon="bell" label="Activos" value={active.length} />
        <Kpi icon="clock" label="Sin atender" value={unattended.length} tone={unattended.length > 0 ? 'warn' : null}
          sub={unattended.length > 0 && oldest !== Infinity ? `+viejo ${fmtAge(now - oldest)}` : 'al día'} />
        <Kpi icon="gauge" label="SLA en riesgo" value={slaRisk.length} tone={slaRisk.length > 0 ? 'warn' : null} />
        <Kpi icon="alert" label="SLA vencido" value={slaBreached.length} tone={slaBreached.length > 0 ? 'crit' : null} />
        <Kpi icon="users" label="Operadores" value={`${avail.length}/${online.length}`}
          sub={paused.length > 0 ? `${paused.length} en pausa` : 'sin pausas'} />
      </div>

      <div className="sup-grid">
        {/* Tablero de operadores */}
        <section className="sup-card">
          <header className="sup-card__head"><Icon name="users" size={16} /> Operadores ({online.length})</header>
          <div className="sup-ops">
            <div className="sup-ops__head"><span>Operador</span><span>Estado</span><span>Carga</span><span>Atendidos</span></div>
            {opRows.length === 0 && <p className="help-block">Ningún operador conectado.</p>}
            {opRows.map((o) => (
              <div className="sup-ops__row" key={o.id}>
                <span className="sup-ops__name"><span className="sup-ops__av">{(o.name || '·').slice(0, 2).toUpperCase()}</span>{o.name}</span>
                <span className={`sup-badge sup-badge--${o.status === 'paused' ? 'warn' : 'ok'}`}>
                  <StatusDot tone={o.status === 'paused' ? 'warn' : 'ok'} />{o.status === 'paused' ? 'En pausa' : 'Disponible'}
                </span>
                <span className={`sup-load${(o.load || 0) >= 3 ? ' is-high' : ''}`}>{o.load || 0}</span>
                <span className="tnum">{o.handled || 0}</span>
              </div>
            ))}
          </div>
        </section>

        {/* Cola en vivo priorizada con SLA */}
        <section className="sup-card">
          <header className="sup-card__head"><Icon name="reception" size={16} /> Cola en vivo ({queue.length})</header>
          <div className="sup-queue">
            {queue.length === 0 && <p className="help-block">Sin eventos activos.</p>}
            {queue.slice(0, 40).map((e) => {
              const d = slaCountdown(e)
              const breach = d != null && d < 0
              const risk = d != null && d >= 0 && d < 120000
              return (
                <div className={`sup-q${breach ? ' is-breach' : risk ? ' is-risk' : ''}`} key={e.id}>
                  <span className="sup-q__prio"><PriorityDot p={e.priority ?? 5} size={9} /> P{e.priority ?? 5}</span>
                  <span className="sup-q__type">{e.type || 'evento'}</span>
                  <span className="sup-q__site">{(e.source && e.source.site) || '—'}</span>
                  <span className="sup-q__age tnum">{fmtAge(now - Date.parse(e.ts))}</span>
                  <span className="sup-q__who">{e.assignedTo ? (opName[e.assignedTo] || 'asignado') : <em>sin asignar</em>}</span>
                  <span className={`sup-q__sla tnum${breach ? ' is-breach' : risk ? ' is-risk' : ''}`}>
                    {d == null ? '—' : breach ? `vencido ${fmtAge(-d)}` : fmtAge(d)}
                  </span>
                </div>
              )
            })}
          </div>
        </section>
      </div>
    </div>
  )
}
