// Panel de Supervisor — mando en tiempo real del centro de monitoreo.
// Visibilidad COMPLETA: KPIs en vivo, tablero de operadores (clic → bitácora del
// operario), cola priorizada con SLA (clic → popup de supervisión solo-lectura),
// y feed de actividad reciente de todo el turno. Sin token de admin: todo se
// deriva de los eventos en vivo (cada evento trae su `log`/bitácora).
import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useConsole } from '../lib/socket.js'
import { Icon, PriorityDot, StatusDot } from '../ui/primitives.jsx'
import { PageHead, SectionHelp } from './_shared.jsx'
import EventPopup from '../components/EventPopup.jsx'

const fmtAge = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}
const fmtClock = (ts) => { try { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) } catch { return '—' } }
const isActive = (e) => e.status !== 'resolved' && e.status !== 'escalated' && e.status !== 'discarded'

// Etiqueta + tono por acción de bitácora.
const ACT = {
  receive: { lbl: 'Recibido', tone: 'sys' }, claim: { lbl: 'Tomado', tone: 'ok' },
  ack: { lbl: 'Acuse', tone: 'info' }, progress: { lbl: 'En curso', tone: 'info' },
  escalate: { lbl: 'Escalado', tone: 'crit' }, resolve: { lbl: 'Resuelto', tone: 'ok' },
  note: { lbl: 'Nota', tone: 'sys' }, transfer: { lbl: 'Transferido', tone: 'warn' },
  call: { lbl: 'Llamada', tone: 'info' }, assign: { lbl: 'Asignado', tone: 'info' },
}
const actMeta = (a) => ACT[a] || { lbl: a || 'evento', tone: 'sys' }

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
  const { events, operators, summary, status, actions } = useConsole(null)
  const [now, setNow] = useState(Date.now())
  const [openId, setOpenId] = useState(null)       // evento abierto en el popup
  const [drawerOp, setDrawerOp] = useState(null)   // operario abierto en el drawer
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
  const opRows = useMemo(() => [...online].sort((a, b) => (b.load || 0) - (a.load || 0)), [online])
  const queue = active

  // Feed de actividad: aplana las bitácoras de todos los eventos (recientes primero).
  const activity = useMemo(() => {
    const rows = []
    for (const e of (events || [])) for (const l of (e.log || [])) rows.push({ ...l, ev: e })
    rows.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))
    return rows
  }, [events])

  const byId = useMemo(() => Object.fromEntries((events || []).map((e) => [e.id, e])), [events])
  const openEvent = openId ? byId[openId] || null : null

  const slaCountdown = (e) => (e.slaDeadline ? Date.parse(e.slaDeadline) - now : null)

  // Datos del drawer del operario seleccionado.
  const opActivity = drawerOp ? activity.filter((r) => r.operatorId === drawerOp.id).slice(0, 80) : []
  const opEvents = drawerOp ? active.filter((e) => e.assignedTo === drawerOp.id) : []

  return (
    <div className="anim-rise sup">
      <PageHead title="Panel de Supervisor"
        subtitle={`Mando en tiempo real del centro de monitoreo · ${status === 'connected' ? 'en vivo' : 'reconectando…'}`} />

      <SectionHelp id="supervisor" icon="gauge" title="Panel de mando del turno">
        Vista en tiempo real con visibilidad completa: eventos críticos y activos, sin atender y su antigüedad, SLA en riesgo/vencido y la carga de cada operario. Hacé clic en un evento para abrir su verificación (video, evidencia, grabación y bitácora) en modo solo-lectura, o en un operario para ver su bitácora de actividad.
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

      <div className="sup-grid sup-grid--3">
        {/* Tablero de operadores (clic → bitácora del operario) */}
        <section className="sup-card">
          <header className="sup-card__head"><Icon name="users" size={16} /> Operadores ({online.length})</header>
          <div className="sup-ops">
            <div className="sup-ops__head"><span>Operador</span><span>Estado</span><span>Carga</span><span>At.</span></div>
            {opRows.length === 0 && <p className="help-block">Ningún operador conectado.</p>}
            {opRows.map((o) => (
              <button type="button" className="sup-ops__row sup-ops__row--btn" key={o.id} onClick={() => setDrawerOp(o)} title="Ver bitácora del operario">
                <span className="sup-ops__name"><span className="sup-ops__av">{(o.name || '·').slice(0, 2).toUpperCase()}</span>{o.name}</span>
                <span className={`sup-badge sup-badge--${o.status === 'paused' ? 'warn' : 'ok'}`}>
                  <StatusDot tone={o.status === 'paused' ? 'warn' : 'ok'} />{o.status === 'paused' ? 'En pausa' : 'Disponible'}
                </span>
                <span className={`sup-load${(o.load || 0) >= 3 ? ' is-high' : ''}`}>{o.load || 0}</span>
                <span className="tnum">{o.handled || 0}</span>
              </button>
            ))}
          </div>
        </section>

        {/* Cola en vivo priorizada con SLA (clic → popup supervisión) */}
        <section className="sup-card">
          <header className="sup-card__head"><Icon name="reception" size={16} /> Cola en vivo ({queue.length})</header>
          <div className="sup-queue">
            {queue.length === 0 && <p className="help-block">Sin eventos activos.</p>}
            {queue.slice(0, 60).map((e) => {
              const d = slaCountdown(e)
              const breach = d != null && d < 0
              const risk = d != null && d >= 0 && d < 120000
              return (
                <button type="button" className={`sup-q sup-q--btn${breach ? ' is-breach' : risk ? ' is-risk' : ''}`} key={e.id} onClick={() => setOpenId(e.id)} title="Abrir verificación (solo lectura)">
                  <span className="sup-q__prio"><PriorityDot p={e.priority ?? 5} size={9} /> P{e.priority ?? 5}</span>
                  <span className="sup-q__type">{e.title || e.type || 'evento'}</span>
                  <span className="sup-q__site">{(e.source && e.source.site) || '—'}</span>
                  <span className="sup-q__age tnum">{fmtAge(now - Date.parse(e.ts))}</span>
                  <span className="sup-q__who">{e.assignedTo ? (opName[e.assignedTo] || 'asignado') : <em>sin asignar</em>}</span>
                  <span className={`sup-q__sla tnum${breach ? ' is-breach' : risk ? ' is-risk' : ''}`}>
                    {d == null ? '—' : breach ? `vencido ${fmtAge(-d)}` : fmtAge(d)}
                  </span>
                </button>
              )
            })}
          </div>
        </section>

        {/* Actividad reciente del turno (bitácora agregada) */}
        <section className="sup-card">
          <header className="sup-card__head"><Icon name="rules" size={16} /> Actividad reciente</header>
          <div className="sup-feed">
            {activity.length === 0 && <p className="help-block">Sin actividad aún.</p>}
            {activity.slice(0, 60).map((r, i) => {
              const m = actMeta(r.action)
              return (
                <button type="button" className="sup-act" key={i} onClick={() => r.ev && setOpenId(r.ev.id)} title="Abrir evento">
                  <span className="sup-act__time tnum">{fmtClock(r.ts)}</span>
                  <span className={`sup-act__tag sup-act__tag--${m.tone}`}>{m.lbl}</span>
                  <span className="sup-act__who">{r.operatorName || r.operatorId || 'sistema'}</span>
                  <span className="sup-act__ev">{(r.ev && (r.ev.title || r.ev.type)) || '—'}</span>
                  {r.note ? <span className="sup-act__note">{r.note}</span> : null}
                </button>
              )
            })}
          </div>
        </section>
      </div>

      {/* Drawer de bitácora del operario */}
      {drawerOp && createPortal(
        <div className="modal-scrim" onClick={() => setDrawerOp(null)}>
          <aside className="sup-drawer" onClick={(e) => e.stopPropagation()}>
            <header className="sup-drawer__head">
              <span className="sup-drawer__id">
                <span className="sup-ops__av sup-ops__av--lg">{(drawerOp.name || '·').slice(0, 2).toUpperCase()}</span>
                <span>
                  <b>{drawerOp.name}</b>
                  <span className={`sup-badge sup-badge--${drawerOp.status === 'paused' ? 'warn' : 'ok'}`}>
                    <StatusDot tone={drawerOp.status === 'paused' ? 'warn' : 'ok'} />{drawerOp.status === 'paused' ? 'En pausa' : 'Disponible'}
                  </span>
                </span>
              </span>
              <button type="button" className="sup-drawer__x" onClick={() => setDrawerOp(null)} aria-label="Cerrar"><Icon name="x" size={18} /></button>
            </header>
            <div className="sup-drawer__stats">
              <div><strong className="tnum">{drawerOp.load || 0}</strong><span>en curso</span></div>
              <div><strong className="tnum">{drawerOp.handled || 0}</strong><span>atendidos</span></div>
              <div><strong className="tnum">{opActivity.length}</strong><span>acciones</span></div>
            </div>

            {opEvents.length > 0 && (
              <div className="sup-drawer__sec">
                <p className="sup-drawer__lbl"><Icon name="reception" size={13} /> Eventos asignados</p>
                {opEvents.map((e) => (
                  <button type="button" className="sup-drawer__ev" key={e.id} onClick={() => { setOpenId(e.id) }}>
                    <PriorityDot p={e.priority ?? 5} size={9} /><span>{e.title || e.type}</span>
                    <span className="sup-drawer__evsite">{(e.source && e.source.site) || ''}</span>
                  </button>
                ))}
              </div>
            )}

            <div className="sup-drawer__sec">
              <p className="sup-drawer__lbl"><Icon name="rules" size={13} /> Bitácora de actividad</p>
              <ul className="sup-drawer__log">
                {opActivity.length === 0 && <li className="help-block">Sin actividad registrada en los eventos en memoria.</li>}
                {opActivity.map((r, i) => {
                  const m = actMeta(r.action)
                  return (
                    <li key={i} className="sup-drawer__logitem" onClick={() => r.ev && setOpenId(r.ev.id)}>
                      <span className="sup-act__time tnum">{fmtClock(r.ts)}</span>
                      <span className={`sup-act__tag sup-act__tag--${m.tone}`}>{m.lbl}</span>
                      <span className="sup-act__ev">{(r.ev && (r.ev.title || r.ev.type)) || '—'}</span>
                      {r.note ? <span className="sup-act__note">{r.note}</span> : null}
                    </li>
                  )
                })}
              </ul>
            </div>
          </aside>
        </div>,
        document.body
      )}

      {/* Popup de verificación en modo SUPERVISIÓN (solo lectura) */}
      {openEvent && (
        <EventPopup event={openEvent} operator={null} actions={actions} supervise onClose={() => setOpenId(null)} />
      )}
    </div>
  )
}
