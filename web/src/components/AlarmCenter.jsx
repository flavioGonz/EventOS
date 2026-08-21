// AlarmCenter — vista "Centro de alarmas" (estilo HikCentral) para el operador.
// Tabla densa de alarmas en vivo (con animación de llegada), pestañas Recientes /
// Ignoradas + pestañas PERSONALIZADAS por filtros (guardables). Acciones rápidas
// (Acuse, Reenviar a grupo, Ignorar, Video) y, abajo, Video&Foto de la alarma
// seleccionada + Mapa centrado en el cliente del evento. Reusa socket + acciones.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Glass, Icon, PriorityDot, Skeleton, Spinner } from '../ui/primitives.jsx'
import { Go2RtcView, useCameraAnalytics, AnalyticsOverlay } from './CameraLive.jsx'
import OperativeMap from './OperativeMap.jsx'
import OperatorBar from './OperatorBar.jsx'
import EventPopup from './EventPopup.jsx'
import OperatorIdentity from './OperatorIdentity.jsx'
import { postWallFocus } from '../lib/wallbus.js'
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
// Alto FIJO de fila (px) para la virtualización de la tabla. Debe coincidir con el
// CSS (.alarmc__row height). Con miles de alarmas (p.ej. Escaladas) sólo se montan
// las filas visibles → no se cuelga la app ni el compositor de Windows.
const ROW_H = 44
const PRIOS = [1, 2, 3, 4, 5]

function matchFilters(e, f) {
  if (f.priorities && f.priorities.length && !f.priorities.includes(e.priority ?? 5)) return false
  if (f.types && f.types.length && !f.types.includes(e.type)) return false
  if (f.site && ((e.source && e.source.site) || '') !== f.site) return false
  if (f.target && ((e.target) || 'none') !== f.target) return false
  return true
}

// ¿El deviceId corresponde a un dispositivo REAL de EventOS? (evita 404 contra
// /api/camera/* cuando el evento trae un modelo como id, p.ej. simulador.)
const isRealDev = (id) => /^dev_/.test(id || '')

function RelatedMedia({ event }) {
  const rawDev = event && event.source && event.source.deviceId
  const devId = isRealDev(rawDev) ? rawDev : null
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
              <img className="acrel__imgc" src={img} alt="" onError={(ev) => { ev.currentTarget.style.visibility = 'hidden' }} />
              <AnalyticsOverlay rules={rules} space={(ana && ana.space) || 1000} />
            </div>
          : <img className="acrel__img" src={img} alt="" onError={(ev) => { ev.currentTarget.style.visibility = 'hidden' }} />)
        : <div className="acrel__empty"><Icon name="camera" size={26} /><span>Sin imagen del momento</span></div>}
      <div className="acrel__cap">
        <Icon name={EVENT_TYPE_ICON[event.type] || 'camera'} size={13} />
        <span className="acrel__cap-title">{event.title || eventTypeLabel(event.type)}</span>
        <span className="acrel__cap-sub">{(event.source && event.source.site) || ''} · {formatTime(event.deviceTs || event.ts)}</span>
      </div>
    </div>
  )
}

// Vivo del canal con skeleton mientras conecta (go2rtc tarda unos segundos).
function LiveCell({ deviceId }) {
  const [loading, setLoading] = useState(true)
  useEffect(() => { setLoading(true); const t = setTimeout(() => setLoading(false), 2600); return () => clearTimeout(t) }, [deviceId])
  return (
    <div className="aclive">
      <Go2RtcView key={deviceId} deviceId={deviceId} />
      {loading && (
        <div className="aclive__skel">
          <Skeleton w="100%" h="100%" />
          <span className="aclive__skel-txt"><Spinner size={14} /> conectando vivo…</span>
        </div>
      )}
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
  const { status, redis, events, operators, summary, selfStats, actions, alertEvent, clearAlert } = c
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
  const [panelsOpen, setPanelsOpen] = useState(true) // paneles inferiores (foto/vivo/mapa) plegables
  const tableWrapRef = useRef(null)
  // Virtualización: seguimos el scroll y el alto del contenedor para montar sólo las
  // filas visibles (+ un colchón). Sin esto, miles de filas × ~10 SVG c/u re-renderizadas
  // por el tick de 1 s saturaban GPU/memoria y colgaban la app y Windows.
  const [scrollTop, setScrollTop] = useState(0)
  const [viewH, setViewH] = useState(640)
  useEffect(() => {
    const el = tableWrapRef.current
    if (!el) return
    const onScroll = () => setScrollTop(el.scrollTop)
    el.addEventListener('scroll', onScroll, { passive: true })
    let ro = null
    try { ro = new ResizeObserver(() => setViewH(el.clientHeight || 640)); ro.observe(el) } catch { /* sin RO */ }
    setViewH(el.clientHeight || 640)
    return () => { el.removeEventListener('scroll', onScroll); if (ro) try { ro.disconnect() } catch { /* noop */ } }
  }, [])
  const fwdRef = useRef(null)
  const seenRef = useRef(null)
  const acRef = useRef(null)
  const bcRef = useRef(null)
  const escSeenRef = useRef(null)
  // Paginación de "Escaladas" desde Postgres (/api/events/history). La cola en memoria
  // (socket) sólo trae lo reciente (cap MAX_EVENTS); con tormentas, los miles de
  // escalados históricos viven en PG. Cargamos por páginas (keyset) con scroll infinito
  // y fusionamos con lo que llega en vivo por socket (live gana en el merge).
  const [escItems, setEscItems] = useState([])   // páginas traídas de PG (histórico)
  const [escBefore, setEscBefore] = useState(null) // cursor keyset (ts ISO del último)
  const [escLoading, setEscLoading] = useState(false)
  const [escDone, setEscDone] = useState(false)  // no hay más páginas
  const escLoadingRef = useRef(false)            // guarda contra doble disparo del scroll
  const fetchEscPage = useCallback((before) => {
    if (escLoadingRef.current) return
    escLoadingRef.current = true
    setEscLoading(true)
    const qs = new URLSearchParams({ status: 'escalated', limit: '150' })
    if (before) qs.set('before', before)
    fetch(`/api/events/history?${qs.toString()}`, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d || !Array.isArray(d.events)) { setEscDone(true); return }
        setEscItems((prev) => (before ? [...prev, ...d.events] : d.events))
        setEscBefore(d.nextBefore || null)
        setEscDone(!d.nextBefore)
      })
      .catch(() => { setEscDone(true) })
      .finally(() => { escLoadingRef.current = false; setEscLoading(false) })
  }, [])
  // Al entrar a la pestaña Escaladas, reiniciar y traer la primera página desde PG.
  useEffect(() => {
    if (tab !== 'escalated') return
    setEscItems([]); setEscBefore(null); setEscDone(false)
    escLoadingRef.current = false
    fetchEscPage(null)
  }, [tab, fetchEscPage])
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

  // Sonido al ESCALAR (SLA vencido): detecta transiciones a 'escalated'.
  useEffect(() => {
    const map = new Map(events.map((e) => [e.id, e.status]))
    if (escSeenRef.current == null) { escSeenRef.current = map; return }
    let escalated = false
    for (const [id, st] of map) {
      if (st === 'escalated' && escSeenRef.current.get(id) !== 'escalated') escalated = true
    }
    escSeenRef.current = map
    if (escalated) beep()
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
  // Pop-up automático: al llegar una alarma (alertEvent), si el toggle está ON,
  // abrir la verificación. Solo en la ventana principal (no en la tabla desacoplada).
  useEffect(() => {
    if (isTablePopout || !autoPopup || !alertEvent) return
    setOpenId((cur) => cur || alertEvent.id)
  }, [alertEvent, autoPopup, isTablePopout])

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

  // Recientes = eventos activos de las últimas 6 h (alivia la tabla). Con
  // "Historial" activado se muestran todos (sin ventana temporal).
  const latest = useMemo(() => {
    const cut = Date.now() - 6 * 3600 * 1000
    return events.filter((e) => {
      if (ignored.has(e.id)) return false
      if (showHistory) return true
      if (!isActive(e)) return false
      return new Date(e.deviceTs || e.ts).getTime() >= cut
    })
  }, [events, ignored, showHistory])
  const ignoredList = useMemo(() => events.filter((e) => ignored.has(e.id)), [events, ignored])
  const escalatedList = useMemo(() => events.filter((e) => e.status === 'escalated'), [events])
  // Tabs fijas nuevas: "Míos" (asignados a mí) y "Grupo" (derivados a un grupo).
  const myId = operator && operator.operatorId
  const mineList = useMemo(() => events.filter((e) => isActive(e) && !ignored.has(e.id) && myId && e.assignedTo === myId), [events, ignored, myId])
  const groupList = useMemo(() => events.filter((e) => isActive(e) && !ignored.has(e.id) && (e.log || []).some((l) => l.action === 'transfer' || l.action === 'reassign')), [events, ignored])
  const activeTab = customTabs.find((t) => t.id === tab)
  // Tabs por PRIORIDAD (estilo HikCentral): cubos con contador para triaje rápido en
  // volumen. Bucket: 1=crítica, 2=alta, 3=media, ≥4=baja. Cuenta sobre lo ACTIVO.
  const prioBucket = (p) => { const n = Number(p) || 5; return n <= 1 ? 1 : n === 2 ? 2 : n === 3 ? 3 : 4 }
  const prioCounts = useMemo(() => {
    const c = { 1: 0, 2: 0, 3: 0, 4: 0 }
    for (const e of events) { if (isActive(e) && !ignored.has(e.id)) c[prioBucket(e.priority)]++ }
    return c
  }, [events, ignored])
  const rows = useMemo(() => {
    if (tab === 'ignored') return ignoredList
    if (tab === 'escalated') {
      // Fusión: histórico de PG (escItems) + escalados vivos (socket). Live gana por id.
      const m = new Map()
      for (const e of escItems) m.set(e.id, e)
      for (const e of escalatedList) m.set(e.id, e)
      return [...m.values()]
        .filter((e) => e.status === 'escalated')
        .sort((a, b) => new Date(b.deviceTs || b.ts).getTime() - new Date(a.deviceTs || a.ts).getTime())
    }
    if (tab === 'mine') return mineList
    if (tab === 'group') return groupList
    if (typeof tab === 'string' && tab.startsWith('prio:')) {
      const b = Number(tab.slice(5))
      return events.filter((e) => isActive(e) && !ignored.has(e.id) && prioBucket(e.priority) === b)
    }
    if (activeTab) return events.filter((e) => isActive(e) && !ignored.has(e.id) && matchFilters(e, activeTab.filters))
    return latest
  }, [tab, activeTab, events, ignored, latest, ignoredList, escalatedList, escItems, mineList, groupList])

  // Buscar un evento por id abarcando la cola en memoria y las páginas PG (escalados
  // que ya no están en memoria). Así el panel/modal abre eventos sólo-PG correctamente.
  const findEvent = useCallback((id) => {
    if (!id) return null
    return events.find((e) => e.id === id) || escItems.find((e) => e.id === id) || null
  }, [events, escItems])
  const selected = selId ? findEvent(selId) : null
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
  // Clasificar/resolver en lote: alarma real o falsa (disposición del evento).
  const resolveAs = (disp) => { const ids = targetIds(); if (!ids.length) return; ids.forEach((id) => actions?.resolve?.(id, disp)); setChecked(new Set()); setSelId(null) }
  // Tomar en lote: el operador se asigna los eventos (claim) y pasan a EN CURSO.
  // Reemplaza al viejo "Acuse" — "tomar" es el concepto claro (asignárselo).
  const takeSelected = () => { const ids = targetIds(); if (!ids.length) return; ids.forEach((id) => { actions?.claim?.(id); actions?.progress?.(id) }); setChecked(new Set()); setSelId(null) }
  const openVideo = () => requestOpen(selId)
  const clearSel = () => { setChecked(new Set()); setSelId(null) }
  const toggleCheck = (id) => setChecked((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const allChecked = rows.length > 0 && rows.every((r) => checked.has(r.id))
  const toggleAll = () => setChecked((prev) => (rows.every((r) => prev.has(r.id)) ? new Set() : new Set(rows.map((r) => r.id))))
  const hasTargets = !!selId || checked.size > 0
  const targetCount = checked.size || (selId ? 1 : 0)
  // Volver arriba de la tabla cuando llega una alarma nueva (lo último, arriba).
  const topRowId = rows.length ? rows[0].id : null
  useEffect(() => { const el = tableWrapRef.current; if (el) { el.scrollTop = 0; setScrollTop(0) } }, [topRowId])

  // Ventana visible (virtualización). Cálculo barato por render; sólo se montan las
  // filas dentro del viewport + colchón. Dos filas espaciadoras mantienen el alto
  // total y la barra de scroll reales.
  const vOver = 8
  const vTotal = rows.length
  const vStart = Math.max(0, Math.floor(scrollTop / ROW_H) - vOver)
  const vEnd = Math.min(vTotal, vStart + Math.ceil((viewH || 640) / ROW_H) + vOver * 2)
  const vRows = rows.slice(vStart, vEnd)
  const padTop = vStart * ROW_H
  const padBottom = Math.max(0, (vTotal - vEnd) * ROW_H)

  // Scroll infinito de "Escaladas": al acercarse al final de lo cargado, pedir la
  // siguiente página a PG. El guard escLoadingRef evita disparos superpuestos.
  useEffect(() => {
    if (tab !== 'escalated' || escDone || escLoadingRef.current) return
    const remaining = vTotal * ROW_H - (scrollTop + (viewH || 640))
    if (remaining < 600) fetchEscPage(escBefore)
  }, [tab, escDone, scrollTop, viewH, vTotal, escBefore, fetchEscPage])

  // Mapa operativo: NO debe re-renderizar en el tick de 1 s ni plotear miles de marcadores.
  // Cap a 400 eventos y elemento memoizado (sólo se recrea si cambian sitios/eventos/foco).
  const mapEvents = useMemo(() => (rows.length > 400 ? rows.slice(0, 400) : rows), [rows])
  const mapEl = useMemo(
    () => <OperativeMap sites={sites} events={mapEvents} focus={focus} onOpenEvent={(ev) => requestOpen(ev.id)} />,
    [sites, mapEvents, focus, requestOpen]
  )

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
  // Auto-scroll de la fila activa al navegar con teclado. Con la lista virtualizada la
  // fila puede no estar montada → calculamos su posición por índice y ajustamos el scroll.
  useEffect(() => {
    if (!selId) return
    const el = tableWrapRef.current; if (!el) return
    const idx = rows.findIndex((r) => r.id === selId)
    if (idx < 0) return
    const top = idx * ROW_H, bottom = top + ROW_H
    if (top < el.scrollTop) el.scrollTop = top
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight
  }, [selId, rows])

  // Al abrir un evento, avisar a los muros (Videowall en otro monitor) para que
  // carguen todas las cámaras del cliente/sitio que reportó el evento.
  useEffect(() => {
    if (!openId) return
    const ev = findEvent(openId)
    if (!ev) return
    const s = ev.source || {}
    postWallFocus({
      type: 'focus-site',
      site: s.site || ev.site || ev.zone || '',
      sourceDeviceId: s.deviceId || null,
      sourceName: s.deviceName || null,
      sourceChannel: s.channel != null ? s.channel : null,
      sourceIp: s.ip || null,
      eventId: ev.id,
    })
  }, [openId]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!operator) return <OperatorIdentity onConfirm={onConfirmIdentity} />
  const openEvent = openId ? findEvent(openId) : null

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
          <button type="button" className={`alarmc__tab alarmc__tab--esc ${tab === 'escalated' ? 'is-active' : ''}`} onClick={() => setTab('escalated')} title="Eventos escalados / SLA vencido">
            <Icon name="alert" size={13} /> Escaladas <span className={`alarmc__count ${escalatedList.length > 0 ? 'alarmc__count--esc' : ''}`}>{escalatedList.length}</span>
          </button>
          <button type="button" className={`alarmc__tab ${tab === 'mine' ? 'is-active' : ''}`} onClick={() => setTab('mine')} title="Eventos asignados a mí (en curso)">
            <Icon name="check" size={13} /> Míos <span className="alarmc__count">{mineList.length}</span>
          </button>
          <button type="button" className={`alarmc__tab ${tab === 'group' ? 'is-active' : ''}`} onClick={() => setTab('group')} title="Eventos derivados a un grupo">
            <Icon name="route" size={13} /> Grupo <span className="alarmc__count">{groupList.length}</span>
          </button>
          <span className="alarmc__tabsep" />
          {[{ b: 1, lbl: 'Crítica', cls: 'prio-1' }, { b: 2, lbl: 'Alta', cls: 'prio-2' }, { b: 3, lbl: 'Media', cls: 'prio-3' }, { b: 4, lbl: 'Baja', cls: 'prio-4' }].map(({ b, lbl, cls }) => (
            prioCounts[b] > 0 ? (
              <button key={b} type="button" className={`alarmc__tab alarmc__tab--prio ${cls} ${tab === `prio:${b}` ? 'is-active' : ''}`} onClick={() => setTab(`prio:${b}`)} title={`Prioridad ${lbl}`}>
                <PriorityDot p={b} size={8} /> {lbl} <span className={`alarmc__count ${b <= 1 ? 'alarmc__count--esc' : ''}`}>{prioCounts[b]}</span>
              </button>
            ) : null
          ))}
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

          {/* Barra de utilidades: en la MISMA fila de las tabs, alineada a la derecha. */}
          <div className="alarmc__toolbar">
            <button type="button" className={`alarmc__toggle ${sound ? 'is-on' : ''}`} onClick={toggleSound} title={sound ? 'Sonido de alarma activado' : 'Sonido silenciado'}>
              <Icon name="speaker" size={14} /> {sound ? 'Sonido' : 'Silencio'}
            </button>
            {onToggleAutoPopup && (
              <button type="button" className={`alarmc__toggle ${autoPopup ? 'is-on' : ''}`} onClick={onToggleAutoPopup} title={autoPopup ? 'Pop-up automático de alarmas: activado' : 'Pop-up automático de alarmas: desactivado'}>
                <Icon name="bell" size={14} /> Pop-up
              </button>
            )}
            <button type="button" className={`alarmc__toggle ${showHistory ? 'is-on' : ''}`} onClick={() => setShowHistory((v) => !v)} title="Incluir resueltas/escaladas">
              <Icon name="clock" size={14} /> Historial
            </button>
            {!isTablePopout && <>
              <button type="button" className={`alarmc__toggle ${panelsOpen ? '' : 'is-on'}`} onClick={() => setPanelsOpen((v) => !v)} title={panelsOpen ? 'Ocultar foto/vivo/mapa para ver más filas' : 'Mostrar foto/vivo/mapa'}>
                <Icon name={panelsOpen ? 'layers' : 'expand'} size={14} /> {panelsOpen ? 'Más filas' : 'Ver paneles'}
              </button>
              <button type="button" className="alarmc__toggle" onClick={popoutTable} title="Abrir la tabla limpia en otra ventana/monitor"><Icon name="expand" size={14} /> Desacoplar tabla</button>
              <a className="alarmc__toggle" href="/admin" title="Configuración"><Icon name="sliders" size={14} /> Config</a>
            </>}
          </div>
        </div>

        {/* Barra de acciones EN LOTE: aparece SOLO cuando se MARCA el checkbox de una o
            más filas (no al seleccionar/click, que sólo enfoca la fila y su preview).
            Estilo notificación desde arriba-centro; desaparece al desmarcar todo. */}
        {!isTablePopout && checked.size > 0 && (
          <div className="selbar" role="toolbar" aria-label="Acciones de selección">
            <span className="selbar__count"><b className="tnum">{targetCount}</b> {targetCount === 1 ? 'alarma' : 'alarmas'}</span>
            <span className="selbar__div" />
            <button type="button" className="selbar__act selbar__act--real" onClick={() => resolveAs('real')}><Icon name="alert" size={15} /> Alarma real</button>
            <button type="button" className="selbar__act selbar__act--false" onClick={() => resolveAs('false_alarm')}><Icon name="check" size={15} /> Falsa alarma</button>
            <button type="button" className="selbar__act" onClick={takeSelected} title="Te asignás el/los evento(s) y pasan a EN CURSO"><Icon name="check" size={15} /> Tomar</button>
            <div className="alarmc__fwd" ref={fwdRef}>
              <button type="button" className="selbar__act" onClick={() => setFwdOpen((v) => !v)}><Icon name="route" size={15} /> Reenviar</button>
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
            <button type="button" className="selbar__act" onClick={bulkIgnore}><Icon name="x" size={15} /> Ignorar</button>
            <button type="button" className="selbar__close" onClick={clearSel} title="Deseleccionar"><Icon name="x" size={15} /></button>
          </div>
        )}

        <div className={`alarmc__tablewrap${panelsOpen ? '' : ' alarmc__tablewrap--tall'}`} ref={tableWrapRef}>
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
              {padTop > 0 && <tr aria-hidden="true" className="alarmc__spacer"><td colSpan={11} style={{ height: padTop, padding: 0, border: 0 }} /></tr>}
              {vRows.map((e) => {
                const p = e.priority ?? 5
                const k = `${(e.source && e.source.deviceId) || '?'}|${e.type}`
                const times = timesByKey.get(k) || 1
                const sel = e.id === selId
                const sla = slaForEvent(e)
                const src = e.source || {}
                const origin = [src.deviceName || src.deviceId, (src.channel != null && src.channel !== '') ? `canal ${src.channel}` : null].filter(Boolean).join(' · ') || '—'
                // ¿Fue reasignada/transferida? (aparece en la bitácora del evento)
                const reassigned = (e.log || []).some((l) => l.action === 'transfer' || l.action === 'reassign')
                return (
                  <tr key={e.id} className={`alarmc__row ${sel ? 'is-sel' : ''} ${priorityClass(p)} ${flash.has(e.id) ? 'is-new' : ''} ${e.disposition === 'real' && isActive(e) ? 'is-real' : ''}`}
                      onClick={() => requestSelect(e.id)} onDoubleClick={() => requestOpen(e.id)}>
                    <td className="alarmc__td-sel" onClick={(ev) => ev.stopPropagation()}><input type="checkbox" checked={checked.has(e.id)} onChange={() => toggleCheck(e.id)} aria-label="Seleccionar alarma" /></td>
                    <td className="alarmc__name"><Icon name={EVENT_TYPE_ICON[e.type] || 'bell'} size={14} /> {e.title || eventTypeLabel(e.type)}
                      {e.target && e.target !== 'none' && <Icon name={TARGET_ICON[e.target] || 'dot'} size={12} className={`alarmc__target alarmc__target--${e.target}`} title={`Objetivo: ${targetLabel(e.target)}`} />}
                      {reassigned && <span className="alarmc__retag" title="Evento reasignado / transferido"><Icon name="route" size={11} /> Reasignada</span>}
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
                        <div className="alarmc__actbar">
                          <button type="button" className="alarmc__act alarmc__act--take" title="Tomar (asignármelo · pasa a EN CURSO)"
                            onClick={() => { actions?.claim?.(e.id); actions?.progress?.(e.id) }}><Icon name="check" size={14} /></button>
                          <button type="button" className="alarmc__act" title="Ver video / verificación"
                            onClick={() => requestOpen(e.id)}><Icon name="play" size={14} /></button>
                          <button type="button" className="alarmc__act alarmc__act--esc" title="Escalar a supervisión"
                            onClick={() => actions?.escalate?.(e.id)}><Icon name="alert" size={14} /></button>
                          <button type="button" className="alarmc__act alarmc__act--real" title="Resolver como ALARMA REAL"
                            onClick={() => actions?.resolve?.(e.id, 'real')}><Icon name="siren" size={14} /></button>
                          <button type="button" className="alarmc__act alarmc__act--false" title="Resolver como FALSA alarma"
                            onClick={() => actions?.resolve?.(e.id, 'false_alarm')}><Icon name="shieldcheck" size={14} /></button>
                          <button type="button" className="alarmc__act" title="Reasignar / reenviar a grupo"
                            onClick={() => { setSelId(e.id); setChecked(new Set([e.id])); setFwdOpen(true) }}><Icon name="route" size={14} /></button>
                          <button type="button" className="alarmc__act alarmc__act--mute" title="Ignorar"
                            onClick={() => ignore(e.id)}><Icon name="x" size={14} /></button>
                        </div>
                      )}
                    </td>
                  </tr>
                )
              })}
              {padBottom > 0 && <tr aria-hidden="true" className="alarmc__spacer"><td colSpan={11} style={{ height: padBottom, padding: 0, border: 0 }} /></tr>}
            </tbody>
          </table>
        </div>

        {!isTablePopout && <p className="alarmc__hint">Clic: seleccionar · Doble clic: abrir verificación · ↑↓ navegar · Enter abrir · Espacio marcar · marcá varias para acciones en lote (aparecen arriba)</p>}

        {!isTablePopout && panelsOpen && (<div className="alarmc__bottom alarmc__bottom--3">
          <section className="alarmc__panel">
            <header className="alarmc__panel-head"><Icon name="camera" size={14} /> Foto del evento</header>
            <div className="alarmc__panel-body"><RelatedMedia event={selected} /></div>
          </section>
          <section className="alarmc__panel">
            <header className="alarmc__panel-head"><Icon name="video" size={14} /> Video en vivo
              {selected && selected.source && (selected.source.deviceName || selected.source.deviceId) && <span className="alarmc__panel-sub">· {selected.source.deviceName || `canal ${selected.source.channel || ''}`}</span>}
            </header>
            <div className="alarmc__panel-body alarmc__livebody">
              {selected && isRealDev(selected.source && selected.source.deviceId)
                ? <LiveCell deviceId={selected.source.deviceId} />
                : <div className="acrel__empty"><Icon name="video" size={26} /><span>{selected ? 'Sin cámara en vivo asociada' : 'Seleccioná una alarma para ver el vivo del canal'}</span></div>}
            </div>
          </section>
          <section className="alarmc__panel">
            <header className="alarmc__panel-head"><Icon name="map" size={14} /> Mapa
              {selected && selected.source && selected.source.site && <span className="alarmc__panel-sub">· {selected.source.site}</span>}
            </header>
            <div className="alarmc__panel-body alarmc__map">
              {mapEl}
            </div>
          </section>
        </div>)}
      </div>

      {!isTablePopout && openEvent && (() => {
        // Navegación por la cola (estilo HikCentral ‹ N/285 ›): recorrer la lista actual
        // sin cerrar el modal, para procesar en volumen.
        const openIdx = rows.findIndex((e) => e.id === openId)
        const navOpen = (dir) => { if (openIdx < 0) return; const ni = openIdx + dir; if (ni >= 0 && ni < rows.length) requestOpen(rows[ni].id) }
        return <EventPopup event={openEvent} operator={operator} actions={actions}
          queuePos={openIdx >= 0 ? { index: openIdx, total: rows.length } : null} onNav={navOpen}
          onClose={() => { setOpenId(null); if (clearAlert) clearAlert() }} />
      })()}
    </div>
  )
}
