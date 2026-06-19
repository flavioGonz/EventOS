// AlarmCenter — vista "Centro de alarmas" (estilo HikCentral) para el operador.
// Tabla densa de alarmas (Latest / Ignoradas) con acciones rápidas (Acuse,
// Reenviar, Ignorar, Video) y, abajo, panel de Video&Foto de la alarma
// seleccionada + Mapa operativo. Reutiliza los eventos y acciones del socket.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Glass, Icon, Badge, PriorityDot } from '../ui/primitives.jsx'
import { Go2RtcView } from './CameraLive.jsx'
import OperativeMap from './OperativeMap.jsx'
import OperatorBar from './OperatorBar.jsx'
import EventPopup from './EventPopup.jsx'
import OperatorIdentity from './OperatorIdentity.jsx'
import { eventTypeLabel, EVENT_TYPE_ICON, priorityLabel, statusLabel, targetLabel, TARGET_ICON } from '../lib/labels.js'
import { formatTime, timeAgo, sourceLine, priorityClass } from '../lib/format.js'

const LS_IGNORED = 'eventos.alarms.ignored'
const loadIgnored = () => { try { return new Set(JSON.parse(localStorage.getItem(LS_IGNORED) || '[]')) } catch { return new Set() } }
const saveIgnored = (set) => { try { localStorage.setItem(LS_IGNORED, JSON.stringify([...set])) } catch { /* ignore */ } }

const isActive = (e) => e.status !== 'resolved' && e.status !== 'escalated'

function RelatedMedia({ event }) {
  const [mode, setMode] = useState('photo') // photo | live
  useEffect(() => { setMode('photo') }, [event && event.id])
  if (!event) {
    return (
      <div className="acrel__empty">
        <Icon name="camera" size={30} />
        <span>Seleccioná una alarma para ver su video y foto</span>
      </div>
    )
  }
  const m = event.media || {}
  const img = m.evidenceUrl || m.snapshotUrl
  const devId = event.source && event.source.deviceId
  return (
    <div className="acrel">
      <div className="acrel__head">
        <span className="acrel__title"><Icon name={EVENT_TYPE_ICON[event.type] || 'camera'} size={14} /> {event.title || eventTypeLabel(event.type)}</span>
        <span className="acrel__time tnum">{formatTime(event.deviceTs || event.ts)}</span>
        <span className="acrel__sp" />
        <div className="acrel__toggle" role="group" aria-label="Foto o vivo">
          <button type="button" className={mode === 'photo' ? 'is-on' : ''} onClick={() => setMode('photo')}>Foto</button>
          <button type="button" className={mode === 'live' ? 'is-on' : ''} onClick={() => setMode('live')} disabled={!devId}>En vivo</button>
        </div>
      </div>
      <div className="acrel__stage">
        {mode === 'live' && devId
          ? <Go2RtcView deviceId={devId} />
          : (img
            ? <img className="acrel__img" src={img} alt="" />
            : <div className="acrel__empty"><Icon name="camera" size={26} /><span>Sin imagen del momento</span></div>)}
      </div>
    </div>
  )
}

export default function AlarmCenter({ operator, onConfirmIdentity, onChangeOperator, console: c }) {
  const { status, redis, events, operators, summary, selfStats, actions } = c
  const [tab, setTab] = useState('latest')
  const [selId, setSelId] = useState(null)
  const [ignored, setIgnored] = useState(loadIgnored)
  const [showHistory, setShowHistory] = useState(false)
  const [fwdFor, setFwdFor] = useState(null) // id del evento con menú de reenvío abierto
  const [openId, setOpenId] = useState(null)
  const [sites, setSites] = useState([])
  const fwdRef = useRef(null)

  useEffect(() => {
    fetch('/api/sites').then((r) => (r.ok ? r.json() : null)).then((d) => { if (d && d.sites) setSites(d.sites) }).catch(() => {})
  }, [])

  // Cerrar menú de reenvío al click fuera.
  useEffect(() => {
    if (!fwdFor) return
    const onDown = (e) => { if (fwdRef.current && !fwdRef.current.contains(e.target)) setFwdFor(null) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [fwdFor])

  const setIgn = useCallback((next) => { setIgnored(next); saveIgnored(next) }, [])
  const ignore = useCallback((id) => { const n = new Set(ignored); n.add(id); setIgn(n); if (selId === id) setSelId(null) }, [ignored, selId, setIgn])
  const restore = useCallback((id) => { const n = new Set(ignored); n.delete(id); setIgn(n) }, [ignored, setIgn])

  // Conteo de repeticiones por (cámara + tipo) sobre las alarmas activas.
  const timesByKey = useMemo(() => {
    const m = new Map()
    for (const e of events) {
      if (!isActive(e)) continue
      const k = `${(e.source && e.source.deviceId) || '?'}|${e.type}`
      m.set(k, (m.get(k) || 0) + 1)
    }
    return m
  }, [events])

  const latest = useMemo(() => events.filter((e) => (showHistory ? true : isActive(e)) && !ignored.has(e.id)), [events, ignored, showHistory])
  const ignoredList = useMemo(() => events.filter((e) => ignored.has(e.id)), [events, ignored])
  const rows = tab === 'latest' ? latest : ignoredList

  const selected = selId ? events.find((e) => e.id === selId) || null : null
  const onlineOps = (operators || []).filter((o) => o.online)

  const ack = () => { if (selId) actions?.ack?.(selId) }
  const forward = (opId) => { if (selId) actions?.transfer?.(selId, opId); setFwdFor(null) }
  const openVideo = () => { if (selId) setOpenId(selId) }

  if (!operator) return <OperatorIdentity onConfirm={onConfirmIdentity} />

  const openEvent = openId ? events.find((e) => e.id === openId) || null : null

  return (
    <div className="console console--work">
      <OperatorBar operator={operator} onChangeOperator={onChangeOperator}
                   status={status} redis={redis} operators={operators}
                   summary={summary} selfStats={selfStats} actions={actions} />

      <div className="alarmc">
        {/* Barra de tabs + acciones (estilo Alarm Center) */}
        <div className="alarmc__tabs">
          <button type="button" className={`alarmc__tab ${tab === 'latest' ? 'is-active' : ''}`} onClick={() => setTab('latest')}>
            Recientes <span className="alarmc__count">{latest.length}</span>
          </button>
          <button type="button" className={`alarmc__tab ${tab === 'ignored' ? 'is-active' : ''}`} onClick={() => setTab('ignored')}>
            Ignoradas <span className="alarmc__count">{ignoredList.length}</span>
          </button>
        </div>

        <div className="alarmc__toolbar">
          <button type="button" className="alarmc__act" disabled={!selId} onClick={ack}><Icon name="check" size={15} /> Acuse</button>
          <div className="alarmc__fwd" ref={fwdRef}>
            <button type="button" className="alarmc__act" disabled={!selId} onClick={() => setFwdFor(fwdFor ? null : selId)}><Icon name="route" size={15} /> Reenviar</button>
            {fwdFor && (
              <Glass strong className="alarmc__menu anim-pop" role="menu">
                <p className="alarmc__menu-title">Reenviar a operario</p>
                {onlineOps.length === 0 && <p className="alarmc__menu-empty">No hay operarios en línea</p>}
                {onlineOps.map((o) => (
                  <button key={o.operatorId || o.id} role="menuitem" className="alarmc__menu-item" onClick={() => forward(o.operatorId || o.id)}>
                    <Icon name="user" size={14} /> {o.name || o.operatorId}
                  </button>
                ))}
              </Glass>
            )}
          </div>
          <button type="button" className="alarmc__act" disabled={!selId} onClick={openVideo}><Icon name="play" size={15} /> Video de alarma</button>
          <span className="alarmc__sp" />
          <span className="alarmc__overview" title="Resumen de la cola">
            <PriorityDot p={1} size={8} /> <strong className="tnum">{(summary && summary.critical) || 0}</strong> críticos ·
            <strong className="tnum"> {(summary && summary.active) || 0}</strong> activos
          </span>
          <button type="button" className={`alarmc__toggle ${showHistory ? 'is-on' : ''}`} onClick={() => setShowHistory((v) => !v)} title="Incluir resueltas/escaladas">
            <Icon name="clock" size={14} /> Historial
          </button>
          <a className="alarmc__toggle" href="/admin/devices" title="Armado / dispositivos"><Icon name="shield" size={14} /> Armado</a>
          <a className="alarmc__toggle" href="/admin" title="Configuración"><Icon name="sliders" size={14} /> Config</a>
        </div>

        {/* Tabla de alarmas */}
        <div className="alarmc__tablewrap">
          <table className="alarmc__table">
            <thead>
              <tr>
                <th className="alarmc__th-sel" />
                <th>Alarma</th><th>Prioridad</th><th>Hora</th><th>Veces</th>
                <th>Origen</th><th>Área</th><th>Evento</th><th>Operación</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr className="alarmc__empty-row"><td colSpan={9}>
                  <div className="alarmc__empty"><Icon name="bell" size={26} /><span>Sin alarmas {tab === 'latest' ? 'recientes' : 'ignoradas'}</span></div>
                </td></tr>
              )}
              {rows.map((e) => {
                const p = e.priority ?? 5
                const k = `${(e.source && e.source.deviceId) || '?'}|${e.type}`
                const times = timesByKey.get(k) || 1
                const sel = e.id === selId
                return (
                  <tr key={e.id} className={`alarmc__row ${sel ? 'is-sel' : ''} ${priorityClass(p)}`} onClick={() => setSelId(e.id)} onDoubleClick={() => setOpenId(e.id)}>
                    <td className="alarmc__td-sel"><span className={`alarmc__radio ${sel ? 'is-on' : ''}`} /></td>
                    <td className="alarmc__name"><Icon name={EVENT_TYPE_ICON[e.type] || 'bell'} size={14} /> {e.title || eventTypeLabel(e.type)}
                      {e.target && e.target !== 'none' && <Icon name={TARGET_ICON[e.target] || 'dot'} size={12} className={`alarmc__target alarmc__target--${e.target}`} title={`Objetivo: ${targetLabel(e.target)}`} />}
                    </td>
                    <td><span className={`alarmc__prio ${priorityClass(p)}`}><PriorityDot p={p} size={8} /> {priorityLabel(p)}</span></td>
                    <td className="tnum alarmc__dim">{formatTime(e.deviceTs || e.ts)}</td>
                    <td className="tnum">{times > 1 ? <span className="alarmc__times">{times}</span> : <span className="alarmc__dim">1</span>}</td>
                    <td className="alarmc__dim">{sourceLine(e)}</td>
                    <td className="alarmc__dim">{e.zone || (e.source && e.source.site) || '—'}</td>
                    <td>{eventTypeLabel(e.type)}</td>
                    <td className="alarmc__ops" onClick={(ev) => ev.stopPropagation()}>
                      {tab === 'latest' ? (
                        <>
                          <button type="button" title="Acuse" onClick={() => actions?.ack?.(e.id)}><Icon name="check" size={14} /></button>
                          <button type="button" title="Video" onClick={() => setOpenId(e.id)}><Icon name="play" size={14} /></button>
                          <button type="button" title="Ignorar" onClick={() => ignore(e.id)}><Icon name="x" size={14} /></button>
                        </>
                      ) : (
                        <button type="button" title="Restaurar" onClick={() => restore(e.id)}><Icon name="refresh" size={14} /> Restaurar</button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {/* Panel inferior: Video&Foto relacionada + Mapa */}
        <div className="alarmc__bottom">
          <section className="alarmc__panel">
            <header className="alarmc__panel-head"><Icon name="video" size={14} /> Video y foto relacionada</header>
            <div className="alarmc__panel-body"><RelatedMedia event={selected} /></div>
          </section>
          <section className="alarmc__panel">
            <header className="alarmc__panel-head"><Icon name="map" size={14} /> Mapa</header>
            <div className="alarmc__panel-body alarmc__map">
              <OperativeMap sites={sites} events={tab === 'latest' ? latest : events} onOpenEvent={(e) => setOpenId(e.id)} />
            </div>
          </section>
        </div>
      </div>

      {openEvent && <EventPopup event={openEvent} operator={operator} actions={actions} onClose={() => setOpenId(null)} />}
    </div>
  )
}
