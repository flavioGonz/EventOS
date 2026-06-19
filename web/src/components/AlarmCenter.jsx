// AlarmCenter — vista "Centro de alarmas" (estilo HikCentral) para el operador.
// Tabla densa de alarmas en vivo (con animación de llegada), pestañas Recientes /
// Ignoradas + pestañas PERSONALIZADAS por filtros (guardables). Acciones rápidas
// (Acuse, Reenviar a grupo, Ignorar, Video) y, abajo, Video&Foto de la alarma
// seleccionada + Mapa centrado en el cliente del evento. Reusa socket + acciones.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Glass, Icon, PriorityDot } from '../ui/primitives.jsx'
import { Go2RtcView, useCameraAnalytics, AnalyticsOverlay } from './CameraLive.jsx'
import OperativeMap from './OperativeMap.jsx'
import OperatorBar from './OperatorBar.jsx'
import EventPopup from './EventPopup.jsx'
import OperatorIdentity from './OperatorIdentity.jsx'
import { eventTypeLabel, EVENT_TYPE_ICON, EVENT_TYPE_LABELS, priorityLabel, targetLabel, TARGET_ICON } from '../lib/labels.js'
import { formatTime, timeAgo, priorityClass, slaInfo } from '../lib/format.js'

const LS_IGNORED = 'eventos.alarms.ignored'
// SLA por defecto (segundos) según prioridad cuando el evento no trae slaDeadline.
const SLA_DEFAULT = { 1: 120, 2: 300, 3: 600, 4: 0, 5: 0 }
function slaForEvent(e) {
  const info = slaInfo(e)
  if (info) return info
  const secs = SLA_DEFAULT[e.priority ?? 5]
  if (!secs) return null
  const base = new Date(e.deviceTs || e.ts).getTime() + secs * 1000
  return slaInfo({ slaDeadline: new Date(base).toISOString(), slaSeconds: secs })
}
const LS_TABS = 'eventos.alarms.tabs'
const loadLS = (k, fb) => { try { const r = localStorage.getItem(k); return r ? JSON.parse(r) : fb } catch { return fb } }
const saveLS = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* ignore */ } }

const isActive = (e) => e.status !== 'resolved' && e.status !== 'escalated'
const PRIOS = [1, 2, 3, 4, 5]

function matchFilters(e, f) {
  if (f.priorities && f.priorities.length && !f.priorities.includes(e.priority ?? 5)) return false
  if (f.types && f.types.length && !f.types.includes(e.type)) return false
  if (f.site && ((e.source && e.source.site) || '') !== f.site) return false
  if (f.target && ((e.target) || 'none') !== f.target) return false
  return true
}

function RelatedMedia({ event }) {
  const devId = event && event.source && event.source.deviceId
  const ana = useCameraAnalytics(devId, !!devId)
  if (!event) {
    return <div className="acrel__empty"><Icon name="camera" size={30} /><span>Seleccioná una alarma para ver su foto</span></div>
  }
  const m = event.media || {}
  const img = m.evidenceUrl || m.snapshotUrl
  const rules = (ana && ana.rules) || []
  const showAna = rules.length > 0
  return (
    <div className={`acrel${showAna ? ' acrel--ana' : ''}`}>
      {img
        ? (showAna
          ? <div className="acrel__stage">
              <img className="acrel__imgc" src={img} alt="" />
              <AnalyticsOverlay rules={rules} space={(ana && ana.space) || 1000} />
            </div>
          : <img className="acrel__img" src={img} alt="" />)
        : <div className="acrel__empty"><Icon name="camera" size={26} /><span>Sin imagen del momento</span></div>}
      <div className="acrel__cap">
        <Icon name={EVENT_TYPE_ICON[event.type] || 'camera'} size={13} />
        <span className="acrel__cap-title">{event.title || eventTypeLabel(event.type)}</span>
        <span className="acrel__cap-sub">{(event.source && event.source.site) || ''} · {formatTime(event.deviceTs || event.ts)}</span>
      </div>
    </div>
  )
}

// Popover para crear una pestaña por filtros.
function NewTabForm({ sites, onSave, onClose }) {
  const [name, setName] = useState('')
  const [priorities, setPriorities] = useState([])
  const [types, setTypes] = useState([])
  const [site, setSite] = useState('')
  const [target, setTarget] = useState('')
  const togglePrio = (p) => setPriorities((a) => a.includes(p) ? a.filter((x) => x !== p) : [...a, p])
  const toggleType = (t) => setTypes((a) => a.includes(t) ? a.filter((x) => x !== t) : [...a, t])
  const save = () => {
    onSave({ id: 'tab_' + Math.random().toString(36).slice(2, 8), name: name.trim() || 'Filtro', filters: { priorities, types, site, target } })
  }
  return (
    <Glass strong className="acnewtab anim-pop" role="dialog">
      <div className="acnewtab__head"><b>Nueva pestaña</b><button type="button" onClick={onClose}><Icon name="x" size={15} /></button></div>
      <label className="acnewtab__lbl">Nombre</label>
      <input className="acnewtab__in" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ej. Intrusiones críticas" autoFocus />
      <label className="acnewtab__lbl">Prioridad</label>
      <div className="acnewtab__chips">
        {PRIOS.map((p) => (
          <button key={p} type="button" className={`acnewtab__chip ${priorities.includes(p) ? 'is-on' : ''}`} onClick={() => togglePrio(p)}>
            <PriorityDot p={p} size={7} /> {priorityLabel(p)}
          </button>
        ))}
      </div>
      <label className="acnewtab__lbl">Tipo de evento</label>
      <div className="acnewtab__chips acnewtab__chips--wrap">
        {Object.keys(EVENT_TYPE_LABELS).map((t) => (
          <button key={t} type="button" className={`acnewtab__chip ${types.includes(t) ? 'is-on' : ''}`} onClick={() => toggleType(t)}>{EVENT_TYPE_LABELS[t]}</button>
        ))}
      </div>
      <div className="acnewtab__row2">
        <div>
          <label className="acnewtab__lbl">Cliente / sitio</label>
          <select className="acnewtab__in" value={site} onChange={(e) => setSite(e.target.value)}>
            <option value="">Todos</option>
            {sites.map((s) => <option key={s.id} value={s.name}>{s.name}</option>)}
          </select>
        </div>
        <div>
          <label className="acnewtab__lbl">Objetivo IA</label>
          <select className="acnewtab__in" value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">Cualquiera</option>
            <option value="human">Humano</option>
            <option value="vehicle">Vehículo</option>
          </select>
        </div>
      </div>
      <div className="acnewtab__foot">
        <button type="button" className="acnewtab__cancel" onClick={onClose}>Cancelar</button>
        <button type="button" className="acnewtab__save" onClick={save}><Icon name="check" size={14} /> Guardar pestaña</button>
      </div>
    </Glass>
  )
}

export default function AlarmCenter({ operator, onConfirmIdentity, onChangeOperator, console: c, autoPopup, onToggleAutoPopup }) {
  const { status, redis, events, operators, summary, selfStats, actions } = c
  // Disposición de pestañas y vista activa POR USUARIO (se recuerda al loguearse).
  const uid = (operator && (operator.operatorId || operator.id)) || 'anon'
  // Modo "tabla desacoplada": ventana limpia (solo tabs + tabla) para otro monitor.
  const isTablePopout = (typeof window !== 'undefined') && new URLSearchParams(window.location.search).get('popout') === 'table'
  const tabsKey = `${LS_TABS}.${uid}`
  const activeKey = `eventos.alarms.active.${uid}`
  const [tab, setTab] = useState(() => loadLS(activeKey, 'latest'))
  const [selId, setSelId] = useState(null)
  const [ignored, setIgnored] = useState(() => new Set(loadLS(LS_IGNORED, [])))
  const [showHistory, setShowHistory] = useState(false)
  const [fwdOpen, setFwdOpen] = useState(false)
  const [openId, setOpenId] = useState(null)
  const [sites, setSites] = useState([])
  const [groups, setGroups] = useState([])
  const [customTabs, setCustomTabs] = useState(() => loadLS(tabsKey, []))
  const [newTabOpen, setNewTabOpen] = useState(false)
  const [flash, setFlash] = useState(() => new Set()) // ids recién llegados (animación)
  const [, setTick] = useState(0) // re-render 1s para el contador de SLA
  const [checked, setChecked] = useState(() => new Set()) // selección múltiple
  const fwdRef = useRef(null)
  const seenRef = useRef(null)
  const acRef = useRef(null)
  const bcRef = useRef(null)
  const [sound, setSound] = useState(() => { try { return localStorage.getItem('eventos.alarms.sound') !== '0' } catch { return true } })
  const toggleSound = () => setSound((v) => { const n = !v; try { localStorage.setItem('eventos.alarms.sound', n ? '1' : '0') } catch { /* ignore */ } return n })

  // Beep de alerta (WebAudio) al llegar eventos nuevos. Se activa tras la primera
  // interacción del operario (política de autoplay del navegador).
  const beep = useCallback(() => {
    if (!sound) return
    try {
      const AC = window.AudioContext || window.webkitAudioContext
      if (!AC) return
      let ctx = acRef.current
      if (!ctx) { ctx = new AC(); acRef.current = ctx }
      if (ctx.state === 'suspended') ctx.resume().catch(() => {})
      const t0 = ctx.currentTime
      const o = ctx.createOscillator(); const g = ctx.createGain()
      o.type = 'sine'
      o.frequency.setValueAtTime(880, t0)
      o.frequency.setValueAtTime(1175, t0 + 0.12)
      g.gain.setValueAtTime(0.0001, t0)
      g.gain.exponentialRampToValueAtTime(0.3, t0 + 0.02)
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.3)
      o.connect(g); g.connect(ctx.destination)
      o.start(t0); o.stop(t0 + 0.32)
    } catch { /* noop */ }
  }, [sound])

  useEffect(() => {
    fetch('/api/sites').then((r) => (r.ok ? r.json() : null)).then((d) => { if (d && d.sites) setSites(d.sites) }).catch(() => {})
    fetch('/api/groups').then((r) => (r.ok ? r.json() : null)).then((d) => { if (d && Array.isArray(d.groups)) setGroups(d.groups) }).catch(() => {})
  }, [])

  // Animar la LLEGADA de eventos nuevos a la lista.
  useEffect(() => {
    const ids = new Set(events.map((e) => e.id))
    if (seenRef.current == null) { seenRef.current = ids; return } // primera carga: no animar
    const fresh = [...ids].filter((id) => !seenRef.current.has(id))
    seenRef.current = ids
    if (fresh.length) {
      setFlash((prev) => { const n = new Set(prev); fresh.forEach((id) => n.add(id)); return n })
      beep()
      const t = setTimeout(() => {
        setFlash((prev) => { const n = new Set(prev); fresh.forEach((id) => n.delete(id)); return n })
      }, 2200)
      return () => clearTimeout(t)
    }
  }, [events, beep])

  useEffect(() => {
    if (!fwdOpen) return
    const onDown = (e) => { if (fwdRef.current && !fwdRef.current.contains(e.target)) setFwdOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [fwdOpen])

  // Contador SLA: re-render cada 1s.
  useEffect(() => { const t = setInterval(() => setTick((n) => n + 1), 1000); return () => clearInterval(t) }, [])
  // Al cambiar de usuario, cargar SU disposición de pestañas y vista activa.
  useEffect(() => { setCustomTabs(loadLS(tabsKey, [])); setTab(loadLS(activeKey, 'latest')) }, [tabsKey, activeKey])
  // Recordar la pestaña activa por usuario.
  useEffect(() => { saveLS(activeKey, tab) }, [tab, activeKey])
  // Sincronización entre ventanas/monitores: la tabla desacoplada (popout) pide
  // abrir el popup en la ventana principal (el otro monitor).
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return
    const bc = new BroadcastChannel('eventos-alarmcenter'); bcRef.current = bc
    if (!isTablePopout) bc.onmessage = (ev) => {
      const d = ev.data || {}
      if (d.type === 'open' && d.id) setOpenId(d.id)
      else if (d.type === 'select' && d.id) setSelId(d.id)
    }
    return () => { try { bc.close() } catch { /* noop */ } bcRef.current = null }
  }, [isTablePopout])

  const persistIgn = useCallback((next) => { setIgnored(next); saveLS(LS_IGNORED, [...next]) }, [])
  const ignore = useCallback((id) => { const n = new Set(ignored); n.add(id); persistIgn(n); if (selId === id) setSelId(null) }, [ignored, selId, persistIgn])
  const restore = useCallback((id) => { const n = new Set(ignored); n.delete(id); persistIgn(n) }, [ignored, persistIgn])
  const addTab = (t) => { const next = [...customTabs, t]; setCustomTabs(next); saveLS(tabsKey, next); setNewTabOpen(false); setTab(t.id) }
  const delTab = (id) => { const next = customTabs.filter((t) => t.id !== id); setCustomTabs(next); saveLS(tabsKey, next); if (tab === id) setTab('latest') }

  const timesByKey = useMemo(() => {
    const m = new Map()
    for (const e of events) { if (!isActive(e)) continue; const k = `${(e.source && e.source.deviceId) || '?'}|${e.type}`; m.set(k, (m.get(k) || 0) + 1) }
    return m
  }, [events])

  const latest = useMemo(() => events.filter((e) => (showHistory ? true : isActive(e)) && !ignored.has(e.id)), [events, ignored, showHistory])
  const ignoredList = useMemo(() => events.filter((e) => ignored.has(e.id)), [events, ignored])
  const activeTab = customTabs.find((t) => t.id === tab)
  const rows = useMemo(() => {
    if (tab === 'ignored') return ignoredList
    if (activeTab) return events.filter((e) => isActive(e) && !ignored.has(e.id) && matchFilters(e, activeTab.filters))
    return latest
  }, [tab, activeTab, events, ignored, latest, ignoredList])

  const selected = selId ? events.find((e) => e.id === selId) || null : null
  // Mapa centrado en el CLIENTE del evento seleccionado.
  const focus = useMemo(() => {
    if (!selected) return null
    const sn = ((selected.source && selected.source.site) || '').toLowerCase()
    const st = sites.find((s) => (s.name || '').toLowerCase() === sn)
    return st && Number.isFinite(st.lat) && Number.isFinite(st.lng) ? [st.lat, st.lng] : null
  }, [selected, sites])

  // Abrir popup: en la tabla desacoplada lo pide a la ventana principal; si no, local.
  const requestOpen = useCallback((id) => {
    if (!id) return
    if (isTablePopout) { try { bcRef.current && bcRef.current.postMessage({ type: 'open', id }) } catch { /* noop */ } setSelId(id) }
    else setOpenId(id)
  }, [isTablePopout])
  // Seleccionar fila: en la tabla desacoplada difunde la selección a la ventana
  // principal para que sus bloques (foto / vivo / mapa) cambien con cada clic.
  const requestSelect = useCallback((id) => {
    setSelId(id)
    if (isTablePopout) { try { bcRef.current && bcRef.current.postMessage({ type: 'select', id }) } catch { /* noop */ } }
  }, [isTablePopout])
  const popoutTable = () => { try { window.open('/center?popout=table', 'eventos-center-table', 'width=1500,height=920,menubar=no,toolbar=no') } catch { /* noop */ } }
  // Acciones: operan sobre las marcadas (selección múltiple) o, si no hay, la fila activa.
  const targetIds = () => (checked.size ? [...checked] : (selId ? [selId] : []))
  const ack = () => { targetIds().forEach((id) => actions?.ack?.(id)); setChecked(new Set()) }
  const forward = (groupId) => { targetIds().forEach((id) => actions?.transfer?.(id, groupId)); setChecked(new Set()); setFwdOpen(false) }
  const bulkIgnore = () => { const ids = targetIds(); if (!ids.length) return; const n = new Set(ignored); ids.forEach((id) => n.add(id)); persistIgn(n); setChecked(new Set()); setSelId(null) }
  const openVideo = () => requestOpen(selId)
  const toggleCheck = (id) => setChecked((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const allChecked = rows.length > 0 && rows.every((r) => checked.has(r.id))
  const toggleAll = () => setChecked((prev) => (rows.every((r) => prev.has(r.id)) ? new Set() : new Set(rows.map((r) => r.id))))
  const hasTargets = !!selId || checked.size > 0

  // Navegación por teclado: ↑/↓ mover · Enter abrir · Espacio marcar.
  useEffect(() => {
    const onKey = (e) => {
      if (openId || newTabOpen) return
      if (/INPUT|TEXTAREA|SELECT/.test((e.target && e.target.tagName) || '')) return
      if (!rows.length) return
      const idx = rows.findIndex((r) => r.id === selId)
      if (e.key === 'ArrowDown') { e.preventDefault(); requestSelect(rows[Math.min(rows.length - 1, idx < 0 ? 0 : idx + 1)].id) }
      else if (e.key === 'ArrowUp') { e.preventDefault(); requestSelect(rows[Math.max(0, idx < 0 ? 0 : idx - 1)].id) }
      else if (e.key === 'Enter') { if (selId) requestOpen(selId) }
      else if (e.key === ' ') { if (selId) { e.preventDefault(); toggleCheck(selId) } }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [rows, selId, openId, newTabOpen, requestOpen, requestSelect])
  // Auto-scroll de la fila activa al navegar con teclado.
  useEffect(() => {
    if (!selId) return
    const el = document.querySelector('.alarmc__row.is-sel')
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' })
  }, [selId])

  if (!operator) return <OperatorIdentity onConfirm={onConfirmIdentity} />
  const openEvent = openId ? events.find((e) => e.id === openId) || null : null

  return (
    <div className={`console console--work console--center${isTablePopout ? ' console--popout' : ''}`}>
      {!isTablePopout && (
        <OperatorBar operator={operator} onChangeOperator={onChangeOperator}
                     status={status} redis={redis} operators={operators}
                     summary={summary} selfStats={selfStats} actions={actions}
                     autoPopup={autoPopup} onToggleAutoPopup={onToggleAutoPopup} />
      )}

      <div className="alarmc">
        {isTablePopout && (
          <div className="alarmc__pophead">
            <Icon name="bell" size={15} /> <b>Centro de alarmas</b> · Tabla
            <span className="alarmc__sp" />
            <span className="alarmc__overview"><PriorityDot p={1} size={8} /> <strong className="tnum">{(summary && summary.critical) || 0}</strong> críticos · <strong className="tnum">{(summary && summary.active) || 0}</strong> activos</span>
          </div>
        )}
        <div className="alarmc__tabs">
          <button type="button" className={`alarmc__tab ${tab === 'latest' ? 'is-active' : ''}`} onClick={() => setTab('latest')}>
            Recientes <span className="alarmc__count">{latest.length}</span>
          </button>
          <button type="button" className={`alarmc__tab ${tab === 'ignored' ? 'is-active' : ''}`} onClick={() => setTab('ignored')}>
            Ignoradas <span className="alarmc__count">{ignoredList.length}</span>
          </button>
          {customTabs.map((t) => {
            const n = events.filter((e) => isActive(e) && !ignored.has(e.id) && matchFilters(e, t.filters)).length
            return (
              <span key={t.id} className={`alarmc__tab alarmc__tab--custom ${tab === t.id ? 'is-active' : ''}`}>
                <button type="button" onClick={() => setTab(t.id)}>{t.name} <span className="alarmc__count">{n}</span></button>
                <button type="button" className="alarmc__tabx" title="Borrar pestaña" onClick={() => delTab(t.id)}><Icon name="x" size={11} /></button>
              </span>
            )
          })}
          <div className="alarmc__newtab">
            <button type="button" className="alarmc__addtab" title="Nueva pestaña por filtros" onClick={() => setNewTabOpen((v) => !v)}><Icon name="plus" size={15} /></button>
            {newTabOpen && <NewTabForm sites={sites} onSave={addTab} onClose={() => setNewTabOpen(false)} />}
          </div>
        </div>

        <div className="alarmc__toolbar">
          <button type="button" className="alarmc__act" disabled={!hasTargets} onClick={ack}><Icon name="check" size={15} /> Acuse{checked.size > 1 ? ` (${checked.size})` : ''}</button>
          <div className="alarmc__fwd" ref={fwdRef}>
            <button type="button" className="alarmc__act" disabled={!hasTargets} onClick={() => setFwdOpen((v) => !v)}><Icon name="route" size={15} /> Reenviar</button>
            {fwdOpen && (
              <Glass strong className="alarmc__menu anim-pop" role="menu">
                <p className="alarmc__menu-title">Reenviar a grupo</p>
                {groups.length === 0 && <p className="alarmc__menu-empty">No hay grupos configurados</p>}
                {groups.map((g) => (
                  <button key={g.id} role="menuitem" className="alarmc__menu-item" onClick={() => forward(g.id)}>
                    <Icon name="shieldcheck" size={14} /> {g.name}
                  </button>
                ))}
              </Glass>
            )}
          </div>
          <button type="button" className="alarmc__act" disabled={!selId} onClick={openVideo}><Icon name="play" size={15} /> Video de alarma</button>
          <button type="button" className="alarmc__act" disabled={!hasTargets} onClick={bulkIgnore}><Icon name="x" size={15} /> Ignorar{checked.size > 1 ? ` (${checked.size})` : ''}</button>
          <span className="alarmc__sp" />
          <button type="button" className={`alarmc__toggle ${sound ? 'is-on' : ''}`} onClick={toggleSound} title={sound ? 'Sonido de alarma activado' : 'Sonido silenciado'}>
            <Icon name="speaker" size={14} /> {sound ? 'Sonido' : 'Silencio'}
          </button>
          <button type="button" className={`alarmc__toggle ${showHistory ? 'is-on' : ''}`} onClick={() => setShowHistory((v) => !v)} title="Incluir resueltas/escaladas">
            <Icon name="clock" size={14} /> Historial
          </button>
          {!isTablePopout && <>
            <button type="button" className="alarmc__toggle" onClick={popoutTable} title="Abrir la tabla limpia en otra ventana/monitor"><Icon name="expand" size={14} /> Desacoplar tabla</button>
            <a className="alarmc__toggle" href="/admin/devices" title="Armado / dispositivos"><Icon name="shield" size={14} /> Armado</a>
            <a className="alarmc__toggle" href="/admin" title="Configuración"><Icon name="sliders" size={14} /> Config</a>
          </>}
        </div>

        <div className="alarmc__tablewrap">
          <table className="alarmc__table">
            <thead>
              <tr>
                <th className="alarmc__th-sel"><input type="checkbox" checked={allChecked} onChange={toggleAll} aria-label="Seleccionar todo" /></th>
                <th>Alarma</th><th>Prioridad</th><th>SLA</th><th>Hora</th><th>Veces</th>
                <th>Origen</th><th>Cliente</th><th>Área</th><th>Evento</th><th>Operación</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr className="alarmc__empty-row"><td colSpan={11}>
                  <div className="alarmc__empty"><Icon name="bell" size={26} /><span>Sin alarmas en esta pestaña</span></div>
                </td></tr>
              )}
              {rows.map((e) => {
                const p = e.priority ?? 5
                const k = `${(e.source && e.source.deviceId) || '?'}|${e.type}`
                const times = timesByKey.get(k) || 1
                const sel = e.id === selId
                const sla = slaForEvent(e)
                const src = e.source || {}
                const origin = [src.deviceName || src.deviceId, (src.channel != null && src.channel !== '') ? `canal ${src.channel}` : null].filter(Boolean).join(' · ') || '—'
                return (
                  <tr key={e.id} className={`alarmc__row ${sel ? 'is-sel' : ''} ${priorityClass(p)} ${flash.has(e.id) ? 'is-new' : ''}`}
                      onClick={() => requestSelect(e.id)} onDoubleClick={() => requestOpen(e.id)}>
                    <td className="alarmc__td-sel" onClick={(ev) => ev.stopPropagation()}><input type="checkbox" checked={checked.has(e.id)} onChange={() => toggleCheck(e.id)} aria-label="Seleccionar alarma" /></td>
                    <td className="alarmc__name"><Icon name={EVENT_TYPE_ICON[e.type] || 'bell'} size={14} /> {e.title || eventTypeLabel(e.type)}
                      {e.target && e.target !== 'none' && <Icon name={TARGET_ICON[e.target] || 'dot'} size={12} className={`alarmc__target alarmc__target--${e.target}`} title={`Objetivo: ${targetLabel(e.target)}`} />}
                    </td>
                    <td><span className={`alarmc__prio ${priorityClass(p)}`}><PriorityDot p={p} size={8} /> {priorityLabel(p)}</span></td>
                    <td>{sla ? <span className={`alarmc__sla alarmc__sla--${sla.tone}`}>{sla.label}</span> : <span className="alarmc__dim">—</span>}</td>
                    <td className="alarmc__dim" title={formatTime(e.deviceTs || e.ts)}>{timeAgo(e.deviceTs || e.ts)}</td>
                    <td className="tnum">{times > 1 ? <span className="alarmc__times">{times}</span> : <span className="alarmc__dim">1</span>}</td>
                    <td className="alarmc__dim">{origin}</td>
                    <td className="alarmc__cli">{src.site || '—'}</td>
                    <td className="alarmc__dim">{e.zone || '—'}</td>
                    <td>{eventTypeLabel(e.type)}</td>
                    <td className="alarmc__ops" onClick={(ev) => ev.stopPropagation()}>
                      {tab === 'ignored' ? (
                        <button type="button" title="Restaurar" onClick={() => restore(e.id)}><Icon name="refresh" size={14} /> Restaurar</button>
                      ) : (
                        <>
                          <button type="button" title="Acuse" onClick={() => actions?.ack?.(e.id)}><Icon name="check" size={14} /></button>
                          <button type="button" title="Video" onClick={() => requestOpen(e.id)}><Icon name="play" size={14} /></button>
                          <button type="button" title="Ignorar" onClick={() => ignore(e.id)}><Icon name="x" size={14} /></button>
                        </>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {!isTablePopout && <p className="alarmc__hint">Clic: seleccionar · Doble clic o «Video de alarma»: abrir verificación · ↑↓ navegar · Enter abrir · Espacio marcar · marcá varias para acuse/ignorar en lote</p>}

        {!isTablePopout && (<div className="alarmc__bottom alarmc__bottom--3">
          <section className="alarmc__panel">
            <header className="alarmc__panel-head"><Icon name="camera" size={14} /> Foto del evento</header>
            <div className="alarmc__panel-body"><RelatedMedia event={selected} /></div>
          </section>
          <section className="alarmc__panel">
            <header className="alarmc__panel-head"><Icon name="video" size={14} /> Video en vivo
              {selected && selected.source && (selected.source.deviceName || selected.source.deviceId) && <span className="alarmc__panel-sub">· {selected.source.deviceName || `canal ${selected.source.channel || ''}`}</span>}
            </header>
            <div className="alarmc__panel-body alarmc__livebody">
              {selected && selected.source && selected.source.deviceId
                ? <Go2RtcView key={selected.source.deviceId} deviceId={selected.source.deviceId} />
                : <div className="acrel__empty"><Icon name="video" size={26} /><span>Seleccioná una alarma para ver el vivo del canal</span></div>}
            </div>
          </section>
          <section className="alarmc__panel">
            <header className="alarmc__panel-head"><Icon name="map" size={14} /> Mapa
              {selected && selected.source && selected.source.site && <span className="alarmc__panel-sub">· {selected.source.site}</span>}
            </header>
            <div className="alarmc__panel-body alarmc__map">
              <OperativeMap sites={sites} events={rows} focus={focus} onOpenEvent={(e) => requestOpen(e.id)} />
            </div>
          </section>
        </div>)}
      </div>

      {!isTablePopout && openEvent && <EventPopup event={openEvent} operator={operator} actions={actions} onClose={() => setOpenId(null)} />}
    </div>
  )
}
