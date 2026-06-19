// Flujos de Eventos — módulo de analítica "Caudal Forense". CONTRACT-V3 §4.
// Stream-graph oscuro de volumen de eventos en el tiempo, con KPIs, filtros,
// leyenda/tabla ordenable y refresco en vivo. Hand-rolled SVG (ver FlowGraph.jsx).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Panel, Glass, Icon, Segmented, Select, Field, TextInput, Spinner, PriorityDot } from '../ui/primitives.jsx'
import { api } from '../lib/adminApi.js'
import {
  priorityLabel, eventTypeLabel, categoryLabel, deviceTypeLabel,
  EVENT_TYPE_LABELS, CATEGORY_LABELS, PRIORITY_LABELS,
} from '../lib/labels.js'
import { PageHead, ErrorState, SectionHelp } from './_shared.jsx'
import FlowGraph, { seriesColor } from './FlowGraph.jsx'
import './flujos.css'

const POLL_MS = 10000

const BUCKET_OPTS = [
  { value: 'minute', label: 'Minuto' },
  { value: 'hour',   label: 'Hora' },
  { value: 'day',    label: 'Día' },
]
const GROUPBY_OPTS = [
  { value: 'priority', label: 'Prioridad' },
  { value: 'type',     label: 'Tipo' },
  { value: 'category', label: 'Categoría' },
  { value: 'vendor',   label: 'Vendor' },
  { value: 'site',     label: 'Sitio' },
  { value: 'target',   label: 'Objetivo (IA)' },
]
const RANGE_OPTS = [
  { value: 'today', label: 'Hoy' },
  { value: '24h',   label: '24 h' },
  { value: '7d',    label: '7 d' },
  { value: 'custom', label: 'Personalizado' },
]

// Etiqueta de una serie según la dimensión agrupada (usa labels.js).
function labelForKey(groupBy, key) {
  if (groupBy === 'priority') return priorityLabel(key)
  if (groupBy === 'type') return eventTypeLabel(key)
  if (groupBy === 'category') return categoryLabel(key)
  if (groupBy === 'vendor') return deviceTypeLabel(key)
  if (groupBy === 'target') return key === 'human' ? 'Persona' : key === 'vehicle' ? 'Vehículo' : key === 'none' ? 'Sin objetivo' : 'Sin clasificar'
  return key // site → nombre tal cual
}

// from/to (ISO) a partir del rango elegido.
function computeRange(range, customFrom, customTo) {
  const now = new Date()
  if (range === 'custom') {
    const f = customFrom ? new Date(customFrom) : new Date(now.getTime() - 24 * 3600e3)
    const t = customTo ? new Date(`${customTo}T23:59:59`) : now
    return { from: f.toISOString(), to: t.toISOString() }
  }
  let from
  if (range === 'today') { from = new Date(now); from.setHours(0, 0, 0, 0) }
  else if (range === '7d') from = new Date(now.getTime() - 7 * 24 * 3600e3)
  else from = new Date(now.getTime() - 24 * 3600e3) // 24h
  return { from: from.toISOString(), to: now.toISOString() }
}

// Bucket por defecto razonable según el rango.
function defaultBucket(range) {
  if (range === '7d') return 'day'
  if (range === 'today' || range === '24h') return 'hour'
  return 'hour'
}

function toDateInput(d) {
  const z = new Date(d)
  return `${z.getFullYear()}-${String(z.getMonth() + 1).padStart(2, '0')}-${String(z.getDate()).padStart(2, '0')}`
}

export default function Flujos() {
  // --- Estado de filtros ---
  const [range, setRange] = useState('24h')
  const [customFrom, setCustomFrom] = useState(toDateInput(Date.now() - 24 * 3600e3))
  const [customTo, setCustomTo] = useState(toDateInput(Date.now()))
  const [bucket, setBucket] = useState('hour')
  const [groupBy, setGroupBy] = useState('priority')
  const [fSite, setFSite] = useState('')
  const [fType, setFType] = useState('')
  const [fPriority, setFPriority] = useState('')
  const [fVendor, setFVendor] = useState('')

  // Cuando cambia el rango, ajustamos el bucket sugerido.
  const onRange = (r) => { setRange(r); setBucket(defaultBucket(r)) }

  // --- Estado de datos ---
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [sortDir, setSortDir] = useState('desc') // por total
  const [highlight, setHighlight] = useState(null) // índice de serie resaltada
  const reqId = useRef(0)

  const query = useMemo(() => {
    const { from, to } = computeRange(range, customFrom, customTo)
    const p = new URLSearchParams({ from, to, bucket, groupBy })
    if (fSite) p.set('site', fSite)
    if (fType) p.set('type', fType)
    if (fPriority) p.set('priority', fPriority)
    if (fVendor) p.set('vendor', fVendor)
    return p.toString()
  }, [range, customFrom, customTo, bucket, groupBy, fSite, fType, fPriority, fVendor])

  const load = useCallback(async (silent) => {
    const id = ++reqId.current
    if (!silent) setLoading(true)
    try {
      const d = await api.get(`/analytics/flow?${query}`)
      if (id === reqId.current) { setData(d); setError(null) }
    } catch (e) {
      if (id === reqId.current && !silent) setError(e)
    } finally {
      if (id === reqId.current) setLoading(false)
    }
  }, [query])

  // Carga al cambiar filtros + poll en vivo.
  useEffect(() => { load(false) }, [load])
  useEffect(() => {
    const t = setInterval(() => load(true), POLL_MS)
    return () => clearInterval(t)
  }, [load])

  // Reset del highlight si cambia la dimensión.
  useEffect(() => { setHighlight(null) }, [groupBy])

  // --- Opciones de filtro derivadas de los totales del endpoint (byType/bySite/...) ---
  const opts = useMemo(() => buildFilterOptions(data), [data])

  // --- KPIs ---
  const kpis = useMemo(() => computeKpis(data, range, customFrom, customTo), [data, range, customFrom, customTo])

  // --- Series ordenadas para la leyenda ---
  const legend = useMemo(() => {
    const list = (data?.series || []).map((ser, si) => ({
      si, ser, total: ser.total ?? (ser.values || []).reduce((a, b) => a + b, 0),
      color: seriesColor(ser, si, groupBy),
    }))
    list.sort((a, b) => (sortDir === 'desc' ? b.total - a.total : a.total - b.total))
    return list
  }, [data, groupBy, sortDir])

  const grandTotal = data?.total ?? 0

  return (
    <div className="anim-rise flujos">
      <PageHead
        title="Flujos de Eventos"
        subtitle="Caudal forense — volumen de eventos en el tiempo, por prioridad y dimensión."
        actions={<LiveTag loading={loading} total={grandTotal} />}
      />

      <SectionHelp id="flujos" icon="gauge" title="Caudal forense de eventos">
        Análisis del volumen de eventos en el tiempo, por prioridad y por dimensión (tipo, sitio, cámara). Sirve para detectar picos de actividad, cámaras «ruidosas» que generan muchas falsas alarmas, y patrones por horario. Ajustá el rango y el agrupamiento para investigar.
      </SectionHelp>

      {/* ---------- KPIs ---------- */}
      <div className="flow-kpis stagger">
        <KpiCard icon="layers"  label="Total de eventos" value={fmtNum(kpis.total)} sub={kpis.rangeLabel} tone="accent" />
        <KpiCard icon="alert"   label="% críticos"       value={`${kpis.critPct}%`} sub={`${fmtNum(kpis.crit)} críticos`} tone="crit" />
        <KpiCard icon="gauge"   label="Tasa por hora"    value={kpis.perHour} sub="eventos / hora" tone="warn" />
        <KpiCard icon="site"    label="Sitio más activo" value={kpis.topSite || '—'} sub={kpis.topSiteCount ? `${fmtNum(kpis.topSiteCount)} eventos` : 'sin datos'} tone="ok" />
      </div>

      {/* ---------- Filtros ---------- */}
      <Glass className="flow-filters">
        <div className="flow-filters__row">
          <div className="flow-filters__grp">
            <span className="flow-lbl"><Icon name="clock" size={14} /> Rango</span>
            <Segmented value={range} onChange={onRange} options={RANGE_OPTS} />
            {range === 'custom' && (
              <span className="flow-filters__dates">
                <TextInput type="date" value={customFrom} max={customTo} onChange={(e) => setCustomFrom(e.target.value)} />
                <span className="flow-dash">—</span>
                <TextInput type="date" value={customTo} min={customFrom} onChange={(e) => setCustomTo(e.target.value)} />
              </span>
            )}
          </div>
          <div className="flow-filters__grp">
            <span className="flow-lbl"><Icon name="sliders" size={14} /> Bucket</span>
            <Segmented value={bucket} onChange={setBucket} options={BUCKET_OPTS} />
          </div>
        </div>

        <div className="flow-filters__row">
          <div className="flow-filters__grp flow-filters__grp--wide">
            <span className="flow-lbl"><Icon name="layers" size={14} /> Agrupar por</span>
            <Segmented value={groupBy} onChange={setGroupBy} options={GROUPBY_OPTS} />
          </div>
        </div>

        <div className="flow-filters__row flow-filters__row--selects">
          <Field label={<span className="flow-lbl"><Icon name="site" size={14} /> Sitio</span>}>
            <Select value={fSite} onChange={(e) => setFSite(e.target.value)}>
              <option value="">Todos</option>
              {opts.sites.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </Select>
          </Field>
          <Field label={<span className="flow-lbl"><Icon name="bolt" size={14} /> Tipo</span>}>
            <Select value={fType} onChange={(e) => setFType(e.target.value)}>
              <option value="">Todos</option>
              {opts.types.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </Select>
          </Field>
          <Field label={<span className="flow-lbl"><Icon name="flag" size={14} /> Prioridad</span>}>
            <Select value={fPriority} onChange={(e) => setFPriority(e.target.value)}>
              <option value="">Todas</option>
              {opts.priorities.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </Select>
          </Field>
          <Field label={<span className="flow-lbl"><Icon name="camera" size={14} /> Vendor</span>}>
            <Select value={fVendor} onChange={(e) => setFVendor(e.target.value)}>
              <option value="">Todos</option>
              {opts.vendors.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </Select>
          </Field>
        </div>
      </Glass>

      {/* ---------- Gráfico + leyenda ---------- */}
      {error ? (
        <ErrorState error={error} onRetry={() => load(false)} />
      ) : (
        <div className="flow-stage">
          <Panel className="flow-stage__graph"
                 title={<span className="ptitle"><Icon name="gauge" size={16} /> Caudal de eventos</span>}
                 subtitle={loading && !data ? 'Cargando…' : `Agrupado por ${labelGroupBy(groupBy)} · bucket ${labelBucket(bucket)}`}>
            {loading && !data ? (
              <div className="flow-loading"><Spinner size={24} /><span>Trazando el caudal…</span></div>
            ) : (
              <FlowGraph
                data={data}
                bucket={data?.bucket || bucket}
                groupBy={data?.groupBy || groupBy}
                highlight={highlight}
              />
            )}
          </Panel>

          <Panel className="flow-stage__legend"
                 title={<span className="ptitle"><Icon name="filter" size={16} /> Series</span>}
                 actions={
                   <button className="flow-sort" onClick={() => setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'))}
                           title="Ordenar por total">
                     Total <Icon name="chevron" size={13} style={{ transform: sortDir === 'desc' ? 'rotate(90deg)' : 'rotate(-90deg)' }} />
                   </button>
                 }>
            {legend.length === 0 ? (
              <div className="flow-legend__empty">Sin series</div>
            ) : (
              <ul className="flow-legend">
                {legend.map(({ si, ser, total, color }) => {
                  const pct = grandTotal ? Math.round((total / grandTotal) * 100) : 0
                  const on = highlight === si
                  return (
                    <li key={si}
                        className={`flow-legend__item${on ? ' is-on' : ''}${highlight != null && !on ? ' is-off' : ''}`}
                        onMouseEnter={() => setHighlight(si)}
                        onMouseLeave={() => setHighlight(null)}
                        onClick={() => setHighlight((h) => (h === si ? null : si))}>
                      {groupBy === 'priority'
                        ? <PriorityDot p={ser.key} size={11} />
                        : <span className="flow-legend__sw" style={{ background: color }} />}
                      <span className="flow-legend__lbl">{ser.label || labelForKey(groupBy, ser.key)}</span>
                      <span className="flow-legend__val tnum">{fmtNum(total)}</span>
                      <span className="flow-legend__pct tnum">{pct}%</span>
                      <span className="flow-legend__bar"><i style={{ width: `${pct}%`, background: color }} /></span>
                    </li>
                  )
                })}
              </ul>
            )}
            <div className="flow-legend__foot">
              <span>Total</span><span className="tnum">{fmtNum(grandTotal)}</span>
            </div>
          </Panel>
        </div>
      )}
    </div>
  )
}

/* ---------- Subcomponentes ---------- */
function KpiCard({ icon, label, value, sub, tone }) {
  return (
    <Glass className={`kpi kpi--${tone}`}>
      <span className="kpi__icon"><Icon name={icon} size={20} /></span>
      <div className="kpi__body">
        <span className="kpi__label">{label}</span>
        <span className="kpi__value tnum">{value}</span>
        {sub && <span className="kpi__sub">{sub}</span>}
      </div>
    </Glass>
  )
}

function LiveTag({ loading, total }) {
  return (
    <span className="flow-live" title="Refresco en vivo cada 10 s">
      <span className={`flow-live__dot${loading ? ' is-busy' : ''}`} />
      En vivo · <span className="tnum">{fmtNum(total)}</span>
    </span>
  )
}

/* ---------- Helpers de datos ---------- */
const fmtNum = (n) => (n == null ? '—' : Number(n).toLocaleString('es-ES'))
const labelBucket = (b) => BUCKET_OPTS.find((o) => o.value === b)?.label || b
const labelGroupBy = (g) => GROUPBY_OPTS.find((o) => o.value === g)?.label || g

// Opciones de los selects derivadas de byType/bySite/byVendor/byPriority del endpoint,
// con fallback a los catálogos de labels.js para que el filtro sea usable aún sin datos.
function buildFilterOptions(data) {
  const fromMap = (map, labeler) =>
    Object.keys(map || {})
      .filter((k) => k !== '' && k != null)
      .map((k) => ({ value: k, label: labeler(k), count: map[k] }))
      .sort((a, b) => (b.count || 0) - (a.count || 0))

  const types = data?.byType ? fromMap(data.byType, eventTypeLabel)
    : Object.keys(EVENT_TYPE_LABELS).map((k) => ({ value: k, label: eventTypeLabel(k) }))
  const sites = data?.bySite ? fromMap(data.bySite, (k) => k) : []
  const vendors = data?.byVendor ? fromMap(data.byVendor, deviceTypeLabel) : []
  const priorities = data?.byPriority ? fromMap(data.byPriority, priorityLabel)
    : Object.keys(PRIORITY_LABELS).map((k) => ({ value: k, label: priorityLabel(k) }))
  return { types, sites, vendors, priorities }
}

function computeKpis(data, range, customFrom, customTo) {
  const total = data?.total ?? 0
  const byPriority = data?.byPriority || {}
  const crit = byPriority['1'] ?? byPriority[1] ?? 0
  const critPct = total ? Math.round((crit / total) * 100) : 0

  // Duración del rango en horas (usamos los límites efectivos del endpoint si vienen).
  const from = data?.from ? new Date(data.from) : new Date(computeRange(range, customFrom, customTo).from)
  const to = data?.to ? new Date(data.to) : new Date(computeRange(range, customFrom, customTo).to)
  const hours = Math.max(1 / 60, (to - from) / 3600e3)
  const perHour = total ? (total / hours).toFixed(total / hours >= 10 ? 0 : 1) : '0'

  // Sitio más activo desde bySite.
  let topSite = null, topSiteCount = 0
  for (const [k, v] of Object.entries(data?.bySite || {})) {
    if (v > topSiteCount) { topSiteCount = v; topSite = k }
  }

  const rangeLabel = RANGE_OPTS.find((o) => o.value === range)?.label || ''
  return { total, crit, critPct, perHour, topSite, topSiteCount, rangeLabel }
}
