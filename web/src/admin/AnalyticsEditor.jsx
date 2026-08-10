// AnalyticsEditor — dibuja/edita las analíticas (línea de cruce / zonas) sobre el
// snapshot de la cámara y las GUARDA en el equipo por ISAPI. Coordenadas 0–1000,
// origen abajo-izquierda (se invierte la Y al mostrar y al guardar).
import { useEffect, useRef, useState } from 'react'
import { Modal, Button, Icon, Spinner } from '../ui/primitives.jsx'
import { api } from '../lib/adminApi.js'
import { useToast } from './_shared.jsx'
import { ANA_LABEL } from '../components/CameraLive.jsx'

const TYPES = [
  { key: 'line', label: 'Cruce de línea', icon: 'bolt', color: '#f5b945', min: 2, kind: 'line' },
  { key: 'field', label: 'Intrusión', icon: 'alert', color: '#e5484d', min: 3, kind: 'poly' },
  { key: 'entrance', label: 'Entrada a zona', icon: 'site', color: '#46a758', min: 3, kind: 'poly' },
  { key: 'exiting', label: 'Salida de zona', icon: 'site', color: '#f5b945', min: 3, kind: 'poly' },
]
const SPACE = 1000
const clamp = (n) => Math.max(0, Math.min(SPACE, n))

export default function AnalyticsEditor({ deviceId, onClose, onSaved }) {
  const toast = useToast()
  const svgRef = useRef(null)
  const [snap, setSnap] = useState(`/api/camera/${deviceId}/snapshot?ts=${Date.now()}`)
  const [aspect, setAspect] = useState('16 / 9')
  const [active, setActive] = useState('line')
  const [pointsByType, setPointsByType] = useState({}) // type → [{x,y}] (convención cámara)
  const [drag, setDrag] = useState(null) // índice de punto en arrastre
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  // Carga las reglas actuales (frescas) para editarlas.
  useEffect(() => {
    let alive = true
    fetch(`/api/camera/${deviceId}/analytics?fresh=1`).then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!alive) return
        const by = {}
        for (const r of (d && d.rules) || []) {
          if (!by[r.type] && Array.isArray(r.points)) by[r.type] = r.points.map((p) => ({ x: p.x, y: p.y }))
        }
        setPointsByType(by)
      })
      .catch(() => {})
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [deviceId])

  const meta = TYPES.find((t) => t.key === active)
  const pts = pointsByType[active] || []
  const setPts = (updater) => setPointsByType((m) => ({ ...m, [active]: typeof updater === 'function' ? updater(m[active] || []) : updater }))

  // Coordenada del evento → punto de cámara (invierte Y).
  const toCam = (e) => {
    const el = svgRef.current; if (!el) return null
    const r = el.getBoundingClientRect()
    const sx = clamp(((e.clientX - r.left) / r.width) * SPACE)
    const sy = clamp(((e.clientY - r.top) / r.height) * SPACE)
    return { x: Math.round(sx), y: Math.round(SPACE - sy) }
  }
  const disp = (p) => ({ x: p.x, y: SPACE - p.y }) // cámara → pantalla

  const onDown = (e) => {
    if (drag != null) return
    const p = toCam(e); if (!p) return
    if (meta.kind === 'line') {
      setPts((cur) => (cur.length >= 2 ? [cur[0], p] : [...cur, p])) // 2 puntos; el 3º reemplaza el final
    } else {
      setPts((cur) => [...cur, p])
    }
  }
  const onMove = (e) => {
    if (drag == null) return
    const p = toCam(e); if (!p) return
    setPts((cur) => cur.map((q, i) => (i === drag ? p : q)))
  }
  const endDrag = () => setDrag(null)

  const save = async () => {
    if (pts.length < meta.min) { toast(`Dibujá al menos ${meta.min} punto(s) para ${meta.label}`, 'error'); return }
    setSaving(true)
    try {
      const r = await api.post('/analytics/save', { deviceId, type: active, points: pts })
      if (r.ok) { toast(`${meta.label} guardada en la cámara`); onSaved?.() }
      else toast(r.message || 'La cámara no aceptó el cambio', 'error')
    } catch (e) { toast(e.message || 'No se pudo guardar', 'error') } finally { setSaving(false) }
  }

  const dpts = pts.map(disp)
  const polyStr = dpts.map((p) => `${p.x},${p.y}`).join(' ')

  return (
    <Modal open size="xl" onClose={onClose} title={<span className="ptitle"><Icon name="filter" size={16} /> Editor de analíticas</span>}
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cerrar</Button>
        <span style={{ flex: 1 }} />
        <Button variant="secondary" icon="refresh" onClick={() => setSnap(`/api/camera/${deviceId}/snapshot?ts=${Date.now()}`)}>Actualizar foto</Button>
        <Button variant="secondary" icon="trash" onClick={() => setPts([])} disabled={!pts.length}>Limpiar</Button>
        <Button variant="primary" icon={saving ? undefined : 'check'} disabled={saving || pts.length < meta.min} onClick={save}>
          {saving ? <Spinner size={15} /> : 'Guardar en la cámara'}
        </Button>
      </>}>
      <div className="anedit">
        <div className="anedit__tabs">
          {TYPES.map((t) => (
            <button type="button" key={t.key} className={`anedit__tab${active === t.key ? ' is-on' : ''}`} onClick={() => setActive(t.key)}>
              <span className="anedit__swatch" style={{ background: t.color }} />
              {t.label}{(pointsByType[t.key] || []).length ? <span className="anedit__n">{(pointsByType[t.key] || []).length}</span> : null}
            </button>
          ))}
        </div>

        <p className="help-block anedit__hint">
          {meta.kind === 'line'
            ? 'Tocá dos puntos para trazar la línea de cruce. Arrastrá los extremos para ajustarla.'
            : 'Tocá para agregar vértices de la zona (mínimo 3). Arrastrá cada vértice para ajustarlo. «Limpiar» reinicia.'}
        </p>

        <div className="anedit__stage" style={{ aspectRatio: aspect }}>
          <img className="anedit__img" src={snap} alt="" onLoad={(e) => { const im = e.currentTarget; if (im.naturalWidth && im.naturalHeight) setAspect(`${im.naturalWidth} / ${im.naturalHeight}`) }} />
          {loading && <div className="anedit__load"><Spinner size={22} /></div>}
          <svg ref={svgRef} className="anedit__svg" viewBox={`0 0 ${SPACE} ${SPACE}`} preserveAspectRatio="none"
               onPointerDown={onDown} onPointerMove={onMove} onPointerUp={endDrag} onPointerLeave={endDrag}>
            {meta.kind === 'line'
              ? <polyline points={polyStr} fill="none" stroke={meta.color} strokeWidth="5" strokeLinecap="round" style={{ filter: 'drop-shadow(0 0 3px rgba(0,0,0,.7))' }} />
              : <polygon points={polyStr} fill={`${meta.color}28`} stroke={meta.color} strokeWidth="4" style={{ filter: 'drop-shadow(0 0 3px rgba(0,0,0,.7))' }} />}
            {dpts.map((p, i) => (
              <circle key={i} cx={p.x} cy={p.y} r="11" fill="#fff" stroke={meta.color} strokeWidth="4"
                      style={{ cursor: 'grab' }} onPointerDown={(e) => { e.stopPropagation(); setDrag(i) }} />
            ))}
          </svg>
          {dpts.length > 0 && (
            <span className="anedit__label" style={{ left: `${(dpts.reduce((s, p) => s + p.x, 0) / dpts.length) / 10}%`, top: `${(dpts.reduce((s, p) => s + p.y, 0) / dpts.length) / 10}%`, borderColor: meta.color }}>
              {ANA_LABEL[active] || meta.label}
            </span>
          )}
        </div>

        <p className="anedit__note"><Icon name="info" size={13} /> Se guarda en la cámara ({pts.length} punto{pts.length === 1 ? '' : 's'}). El overlay del vivo se sincroniza al cerrar.</p>
      </div>
    </Modal>
  )
}
