// EvidenceSearch — "Búsqueda IA" de evidencias estilo UniFi Protect.
// Grilla de eventos con su foto/evidencia + filtros (texto, tiempo, objetivo,
// tipo, prioridad, sitio). Clic en una tarjeta → detalle con evidencia grande +
// metadatos + acceso al VIVO de la cámara (modal premium reutilizado).
import { useEffect, useMemo, useState } from 'react'
import { Icon, Segmented, Select, TextInput, Modal, Button, Badge } from '../ui/primitives.jsx'
import { PageHead, Loading } from './_shared.jsx'
import { api } from '../lib/adminApi.js'
import { CameraModal } from './CameraWallView.jsx'
import { AnalyticsOverlay, AnalyticsLegend, useCameraAnalytics } from '../components/CameraLive.jsx'
import {
  eventTypeLabel, priorityLabel, EVENT_TYPE_ICON, EVENT_TYPE_LABELS,
  TARGET_LABELS, TARGET_ICON, statusLabel,
} from '../lib/labels.js'

const RANGES = [
  { value: 'today', label: 'Hoy' },
  { value: '24h', label: '24 h' },
  { value: '7d', label: '7 días' },
  { value: '30d', label: '30 días' },
  { value: 'all', label: 'Todo' },
]
const TARGETS = [
  { value: 'all', label: 'Todos', icon: 'filter' },
  { value: 'human', label: 'Personas', icon: 'user' },
  { value: 'vehicle', label: 'Vehículos', icon: 'car' },
]

const rangeStart = (r) => {
  const now = Date.now()
  if (r === 'today') { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime() }
  if (r === '24h') return now - 864e5
  if (r === '7d') return now - 7 * 864e5
  if (r === '30d') return now - 30 * 864e5
  return 0
}
const fmtTime = (ts) => { const d = new Date(ts); return d.toLocaleString('es', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) }
const fmtRel = (ts) => { const m = Math.floor((Date.now() - new Date(ts).getTime()) / 60000); if (m < 1) return 'recién'; if (m < 60) return `hace ${m} min`; const h = Math.floor(m / 60); return h < 24 ? `hace ${h} h` : `hace ${Math.floor(h / 24)} d` }

// La foto de la tarjeta: SOLO la evidencia guardada del evento (la foto del
// momento, capturada al ingerir). No adivinamos snapshots en vivo por deviceId
// (daba 404 en eventos sin cámara real). Sin evidencia → placeholder con icono.
function evidenceSrc(ev) {
  const m = ev.media || {}
  return m.evidenceUrl || m.snapshotUrl || null
}

function EvidenceCard({ ev, onOpen }) {
  const [failed, setFailed] = useState(false)
  const src = evidenceSrc(ev)
  const icon = EVENT_TYPE_ICON[ev.type] || 'camera'
  const tgt = ev.target && ev.target !== 'none' ? ev.target : null
  return (
    <button type="button" className={`evscard p${ev.priority || 3}`} onClick={() => onOpen(ev)} title={eventTypeLabel(ev.type)}>
      <span className="evscard__media">
        {src && !failed
          ? <img className="evscard__img" alt="" loading="lazy" src={src} onError={() => setFailed(true)} />
          : <span className="evscard__noimg"><Icon name={icon} size={26} /></span>}
        <span className={`evscard__pri p${ev.priority || 3}`}>P{ev.priority || 3}</span>
        {tgt && <span className={`evscard__tgt t-${tgt}`}><Icon name={TARGET_ICON[tgt] || 'filter'} size={11} /> {TARGET_LABELS[tgt]}</span>}
        <span className="evscard__type"><Icon name={icon} size={12} /> {eventTypeLabel(ev.type)}</span>
        <span className="evscard__play"><Icon name="play" size={16} /></span>
      </span>
      <span className="evscard__foot">
        <span className="evscard__cam">{ev.source?.deviceName || ev.zone || 'Cámara'}</span>
        <span className="evscard__time">{fmtRel(ev.ts)}</span>
      </span>
    </button>
  )
}

function EvidenceModal({ ev, onClose }) {
  const [live, setLive] = useState(false)
  const [vAspect, setVAspect] = useState(16 / 9)
  const src = evidenceSrc(ev)
  const deviceId = ev.source?.deviceId
  const [imgs, setImgs] = useState(null)
  const [idx, setIdx] = useState(0)
  const [busy, setBusy] = useState(false)
  const reloadEvidence = () => fetch(`/api/events/${ev.id}/evidence`).then((r) => r.json()).then((d) => setImgs(Array.isArray(d.images) ? d.images : [])).catch(() => setImgs([]))
  useEffect(() => { reloadEvidence() }, [ev.id])
  const gallery = (imgs && imgs.length) ? imgs : (src ? [{ url: src, ts: new Date(ev.ts).getTime() }] : [])
  const curIdx = Math.min(idx, Math.max(0, gallery.length - 1))
  const mainSrc = gallery.length ? gallery[curIdx].url : null
  const capture = async () => {
    if (!deviceId || busy) return
    setBusy(true)
    try { const r = await fetch(`/api/events/${ev.id}/evidence/capture`, { method: 'POST' }); if (r.ok) { await reloadEvidence(); setIdx(999) } } finally { setBusy(false) }
  }
  const icon = EVENT_TYPE_ICON[ev.type] || 'camera'
  const tgt = ev.target && ev.target !== 'none' ? ev.target : null
  // Analíticas de la cámara (líneas de cruce / zonas) para dibujarlas sobre la foto.
  const ana = useCameraAnalytics(deviceId, !!deviceId)
  const hasAna = ana && ana.rules && ana.rules.length > 0

  if (live && deviceId) {
    const cam = { id: deviceId, name: ev.source?.deviceName || ev.zone || 'Cámara', channel: ev.source?.channel, zone: ev.source?.site, ip: ev.source?.ip }
    return <CameraModal cam={cam} onClose={() => setLive(false)} />
  }
  // El escenario calza al aspecto REAL de la foto → sin marcos, y el overlay de
  // analíticas alinea exacto sobre la imagen.
  const stageStyle = mainSrc ? { width: `clamp(360px, calc(var(--camh) * ${vAspect.toFixed(4)}), 76vw)` } : undefined

  return (
    <Modal open size="xl" onClose={onClose}>
      <div className="campremium">
        <div className="campremium__stage evstage" style={stageStyle}>
          {mainSrc
            ? <>
                <img className="evstage__img" alt="Evidencia" src={mainSrc}
                  onLoad={(e) => { const im = e.currentTarget; if (im.naturalWidth && im.naturalHeight) setVAspect(im.naturalWidth / im.naturalHeight) }} />
                {hasAna && <AnalyticsOverlay rules={ana.rules} space={ana.space || 1000} />}
              </>
            : <div className="evstage__none"><Icon name={icon} size={40} /><span>Sin imagen de evidencia</span></div>}
          <div className="campremium__top">
            <span className={`evscard__pri p${ev.priority || 3}`} style={{ position: 'static' }}>P{ev.priority || 3} · {priorityLabel(ev.priority || 3)}</span>
            <span className="campremium__sp" />
            {hasAna && <span className="evstage__anatag"><Icon name="filter" size={12} /> {ana.rules.length} analítica{ana.rules.length === 1 ? '' : 's'}</span>}
          </div>
        </div>
        <aside className="campremium__rail">
          <header className="campremium__railhead">
            <span className="campremium__name"><Icon name={icon} size={16} /> {eventTypeLabel(ev.type)}</span>
            <button type="button" className="campremium__close" onClick={onClose} aria-label="Cerrar"><Icon name="x" size={18} /></button>
          </header>
          <div className="campremium__status">
            <Icon name="clock" size={14} />
            <strong>{fmtTime(ev.ts)}</strong>
            <span className="campremium__lastev">{fmtRel(ev.ts)}</span>
          </div>
          <div className="caminfo">
            {tgt && <div className="caminfo__row"><span className="caminfo__k">Objetivo</span><span className="caminfo__v"><Icon name={TARGET_ICON[tgt]} size={12} /> {TARGET_LABELS[tgt]}</span></div>}
            <div className="caminfo__row"><span className="caminfo__k">Cámara</span><span className="caminfo__v">{ev.source?.deviceName || '—'}</span></div>
            <div className="caminfo__row"><span className="caminfo__k">Canal</span><span className="caminfo__v">{ev.source?.channel ? `#${ev.source.channel}` : '—'}</span></div>
            <div className="caminfo__row"><span className="caminfo__k">Sitio</span><span className="caminfo__v">{ev.source?.site || '—'}</span></div>
            <div className="caminfo__row"><span className="caminfo__k">Zona</span><span className="caminfo__v">{ev.zone || '—'}</span></div>
            <div className="caminfo__row"><span className="caminfo__k">Estado</span><span className="caminfo__v">{statusLabel(ev.status)}</span></div>
            <div className="caminfo__row"><span className="caminfo__k">IP</span><span className="caminfo__v">{ev.source?.ip || '—'}</span></div>
          </div>
          {ev.message && <p className="evmsg">{ev.message}</p>}
          {hasAna && (
            <div className="campremium__railana">
              <p className="caminfo__sec">Analíticas sobre la imagen</p>
              <AnalyticsLegend rules={ana.rules} />
            </div>
          )}
          <div className="campremium__railana evgal">
            <p className="caminfo__sec">Fotos del caso ({gallery.length})</p>
            {gallery.length > 1 && (
              <div className="evgal__thumbs">
                {gallery.map((g, i) => (
                  <button key={g.url} type="button" className={`evgal__thumb${i === curIdx ? ' is-on' : ''}`} onClick={() => setIdx(i)}>
                    <img src={g.url} alt="" loading="lazy" />
                  </button>
                ))}
              </div>
            )}
            <div className="evgal__actions">
              {deviceId && <Button variant="secondary" icon="camera" onClick={capture} disabled={busy}>{busy ? 'Capturando…' : 'Capturar ahora'}</Button>}
              {mainSrc && <a className="btn btn--secondary btn--md" href={mainSrc} download={`evidencia-${ev.id}.jpg`}>Descargar</a>}
            </div>
          </div>
          {deviceId && (
            <div className="campremium__railana">
              <Button variant="primary" icon="play" onClick={() => setLive(true)} className="u-full">Ver cámara en vivo</Button>
            </div>
          )}
        </aside>
      </div>
    </Modal>
  )
}

export default function EvidenceSearch({ site: fixedSite = null, embedded = false }) {
  const [events, setEvents] = useState(null)
  const [retDays, setRetDays] = useState(null)
  const [savingRet, setSavingRet] = useState(false)
  const [q, setQ] = useState('')
  const [range, setRange] = useState('7d')
  const [target, setTarget] = useState('all')
  const [type, setType] = useState('')
  const [priority, setPriority] = useState('')
  const [site, setSite] = useState('')
  const [open, setOpen] = useState(null)
  const siteFilter = fixedSite || site
  useEffect(() => { if (embedded) return; api.get('/evidence').then((cfg) => setRetDays(cfg.retentionDays ?? 30)).catch(() => {}) }, [embedded])
  const saveRet = async () => { setSavingRet(true); try { const cfg = await api.put('/evidence', { retentionDays: Number(retDays) || 0 }); setRetDays(cfg.retentionDays) } catch { /* noop */ } finally { setSavingRet(false) } }

  useEffect(() => {
    let alive = true
    const load = () => fetch('/api/events?limit=500').then((r) => r.json()).then((d) => { if (alive) setEvents(Array.isArray(d) ? d : (d.events || [])) }).catch(() => { if (alive) setEvents([]) })
    load(); const t = setInterval(load, 15000)
    return () => { alive = false; clearInterval(t) }
  }, [])

  const sites = useMemo(() => [...new Set((events || []).map((e) => e.source?.site).filter(Boolean))].sort(), [events])
  const types = useMemo(() => [...new Set((events || []).map((e) => e.type).filter(Boolean))], [events])

  const filtered = useMemo(() => {
    if (!events) return []
    const start = rangeStart(range)
    const ql = q.trim().toLowerCase()
    return events.filter((e) => {
      if (new Date(e.ts).getTime() < start) return false
      if (target !== 'all' && e.target !== target) return false
      if (type && e.type !== type) return false
      if (priority && String(e.priority) !== priority) return false
      if (siteFilter && e.source?.site !== siteFilter) return false
      if (ql) {
        const hay = `${e.source?.deviceName || ''} ${e.source?.site || ''} ${e.zone || ''} ${eventTypeLabel(e.type)} ${e.message || ''}`.toLowerCase()
        if (!hay.includes(ql)) return false
      }
      return true
    }).sort((a, b) => new Date(b.ts) - new Date(a.ts))
  }, [events, range, target, type, priority, siteFilter, q])

  if (!events) return <Loading label="Cargando evidencias…" />

  return (
    <div className="evsearch">
      {!embedded && (
        <PageHead title="Búsqueda IA · Evidencias"
          subtitle="Explora los eventos con su foto del momento. Filtra por objetivo (personas / vehículos), tipo, prioridad, cámara y tiempo."
          actions={retDays !== null && (
            <div className="evret">
              <Icon name="clock" size={14} /><span>Retención</span>
              <TextInput type="number" min="0" className="evret__in" value={retDays} onChange={(e) => setRetDays(e.target.value)} />
              <span className="muted">días</span>
              <Button variant="secondary" onClick={saveRet} disabled={savingRet}>{savingRet ? 'Guardando…' : 'Guardar'}</Button>
            </div>
          )} />
      )}

      <div className="evbar">
        <div className="evbar__search">
          <Icon name="search" size={16} />
          <input className="evbar__input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar cámara, sitio, zona o tipo…" />
          {q && <button className="evbar__clear" onClick={() => setQ('')} aria-label="Limpiar"><Icon name="x" size={14} /></button>}
        </div>
        <div className="evchips">
          {TARGETS.map((t) => (
            <button key={t.value} type="button" className={`evchip${target === t.value ? ' is-on' : ''} t-${t.value}`} onClick={() => setTarget(t.value)}>
              <Icon name={t.icon} size={13} /> {t.label}
            </button>
          ))}
        </div>
        <Segmented value={range} onChange={setRange} options={RANGES} />
        <Select value={type} onChange={(e) => setType(e.target.value)} className="evsel">
          <option value="">Todos los tipos</option>
          {types.map((t) => <option key={t} value={t}>{EVENT_TYPE_LABELS[t] || t}</option>)}
        </Select>
        <Select value={priority} onChange={(e) => setPriority(e.target.value)} className="evsel">
          <option value="">Toda prioridad</option>
          {[1, 2, 3, 4, 5].map((p) => <option key={p} value={String(p)}>{`P${p} · ${priorityLabel(p)}`}</option>)}
        </Select>
        {!fixedSite && sites.length > 1 && (
          <Select value={site} onChange={(e) => setSite(e.target.value)} className="evsel">
            <option value="">Todos los sitios</option>
            {sites.map((s) => <option key={s} value={s}>{s}</option>)}
          </Select>
        )}
        <span className="evbar__count"><b>{filtered.length}</b> evento{filtered.length === 1 ? '' : 's'}</span>
      </div>

      {filtered.length === 0
        ? <div className="evempty"><Icon name="search" size={28} /><p>Ningún evento coincide con los filtros.</p></div>
        : <div className="evgrid">{filtered.map((ev) => <EvidenceCard key={ev.id} ev={ev} onOpen={setOpen} />)}</div>}

      {open && <EvidenceModal ev={open} onClose={() => setOpen(null)} />}
    </div>
  )
}
