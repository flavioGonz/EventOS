// DeviceCaptures — grilla de capturas (historial de alertas con foto) de un
// dispositivo, debajo del video en vivo en su ficha. Clic → detalle de evidencia.
import { useEffect, useState } from 'react'
import { Icon, Spinner } from '../ui/primitives.jsx'
import { EvidenceModal } from './EvidenceSearch.jsx'
import { EVENT_TYPE_ICON, eventTypeLabel } from '../lib/labels.js'

const capSrc = (ev) => { const m = ev.media || {}; return m.evidenceUrl || m.snapshotUrl || null }
const rel = (ts) => { const m = Math.floor((Date.now() - new Date(ts).getTime()) / 60000); if (m < 1) return 'recién'; if (m < 60) return `${m}m`; const h = Math.floor(m / 60); return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d` }

const PAGE = 18 // ~3 filas

export default function DeviceCaptures({ deviceId }) {
  const [events, setEvents] = useState(null)
  const [open, setOpen] = useState(null)
  const [visible, setVisible] = useState(PAGE)

  const onScroll = (e) => {
    const el = e.currentTarget
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 48) {
      setVisible((v) => (events ? Math.min(v + PAGE, events.length) : v))
    }
  }

  useEffect(() => {
    if (!deviceId) return
    let alive = true
    const load = () => fetch('/api/events?limit=400').then((r) => (r.ok ? r.json() : []))
      .then((d) => {
        if (!alive) return
        const arr = Array.isArray(d) ? d : (d.events || [])
        setEvents(arr.filter((e) => e.source?.deviceId === deviceId).sort((a, b) => new Date(b.ts) - new Date(a.ts)))
      })
      .catch(() => { if (alive) setEvents([]) })
    load(); const t = setInterval(load, 20000)
    return () => { alive = false; clearInterval(t) }
  }, [deviceId])

  return (
    <div className="devcaps">
      <div className="devcaps__hd">
        <span className="devcaps__t"><Icon name="camera" size={14} /> Capturas</span>
        <span className="devcaps__sub">historial de alertas de este equipo{events ? ` · ${events.length}` : ''}</span>
      </div>
      {!events
        ? <div className="devcaps__load"><Spinner size={16} /></div>
        : events.length === 0
          ? <p className="help-block devcaps__empty">Sin capturas todavía. Aparecen acá cuando el equipo genera una alerta con foto.</p>
          : <div className="devcaps__grid" onScroll={onScroll}>
              {events.slice(0, visible).map((ev) => {
                const src = capSrc(ev); const pri = ev.priority || 3
                return (
                  <button type="button" key={ev.id} className="devcap" onClick={() => setOpen(ev)} title={`${eventTypeLabel(ev.type)} · ${rel(ev.ts)}`}>
                    {src
                      ? <img className="devcap__img" src={src} alt="" loading="lazy" onError={(e) => { e.currentTarget.style.display = 'none' }} />
                      : <span className="devcap__noimg"><Icon name={EVENT_TYPE_ICON[ev.type] || 'camera'} size={18} /></span>}
                    <span className={`devcap__pri p${pri}`}>P{pri}</span>
                    <span className="devcap__time">{rel(ev.ts)}</span>
                  </button>
                )
              })}
            </div>}
      {open && <EvidenceModal ev={open} onClose={() => setOpen(null)} />}
    </div>
  )
}
