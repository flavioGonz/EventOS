// Panel de salud del NVR: GRILLA DE CANALES (8/16/32) con color por slot y estado,
// tooltip con VIDEO EN VIVO del canal, DISCOS + SMART/temperatura, y LOGS CRÍTICOS.
// Iconografía Lucide (Icon usa el mismo formato stroke). Datos: /api/admin/nvr/:id/panel.
import { useEffect, useRef, useState } from 'react'
import { Icon, Spinner } from '../ui/primitives.jsx'
import { getNvrPanel } from '../lib/adminApi.js'
import { Go2RtcView } from '../components/CameraLive.jsx'

const fmtGB = (mb) => (mb == null ? '—' : mb >= 1024 * 1024 ? `${(mb / 1024 / 1024).toFixed(2)} TB` : `${(mb / 1024).toFixed(0)} GB`)
const fmtRel = (ts) => { if (!ts) return ''; const m = Math.floor((Date.now() - new Date(ts).getTime()) / 60000); if (m < 1) return 'recién'; if (m < 60) return `hace ${m}m`; const h = Math.floor(m / 60); return h < 24 ? `hace ${h}h` : `hace ${Math.floor(h / 24)}d` }
const fmtClock = (ts) => { try { return new Date(ts).toLocaleString([], { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) } catch { return '' } }

export default function NvrChannelPanel({ device }) {
  const [data, setData] = useState(undefined)
  const [hover, setHover] = useState(null) // {ch, deviceId, name, x, y}
  const wrapRef = useRef(null)

  useEffect(() => {
    if (!device || !device.id) return
    let alive = true
    const load = () => getNvrPanel(device.id).then((d) => { if (alive) setData(d || null) }).catch(() => { if (alive) setData(null) })
    load(); const t = setInterval(load, 30000)
    return () => { alive = false; clearInterval(t) }
  }, [device && device.id])

  if (data === undefined) return <div className="admin-center"><Spinner size={18} /><span>Consultando el NVR…</span></div>
  if (!data) return <p className="help-block">Sin datos del NVR (¿responde por ISAPI?).</p>

  const onEnter = (e, ch) => {
    if (!ch.deviceId) { setHover(null); return }
    const r = e.currentTarget.getBoundingClientRect()
    setHover({ ch: ch.ch, deviceId: ch.deviceId, name: ch.name, x: r.left + r.width / 2, y: r.top })
  }

  return (
    <div className="nvrpanel" ref={wrapRef}>
      {/* ── Grilla de canales ── */}
      <div className="nvrpanel__sec">
        <p className="nvrpanel__lbl"><Icon name="grid" size={14} /> Canales <span className="nvrpanel__n">{data.total}</span>
          <span className="nvrpanel__legend">
            <span><i className="nvrslot__dot nvrslot__dot--on" /> ocupado</span>
            <span><i className="nvrslot__dot nvrslot__dot--off" /> sin señal</span>
            <span><i className="nvrslot__dot nvrslot__dot--empty" /> libre</span>
          </span>
        </p>
        <div className="nvrgrid">
          {data.channels.map((ch) => {
            const cls = !ch.occupied ? 'is-empty' : ch.online ? 'is-on' : 'is-off'
            return (
              <button type="button" key={ch.ch} className={`nvrslot ${cls}${ch.deviceId ? ' has-live' : ''}`}
                onMouseEnter={(e) => onEnter(e, ch)} onMouseLeave={() => setHover(null)}
                title={ch.name || `Canal ${ch.ch}`} aria-label={ch.name || `Canal ${ch.ch}`}>
                <span className="nvrslot__ch tnum">{ch.ch}</span>
                {ch.occupied && !ch.online && <span className="nvrslot__warn"><Icon name="wifioff" size={11} /></span>}
              </button>
            )
          })}
        </div>
      </div>

      {/* ── Discos + SMART ── */}
      <div className="nvrpanel__sec">
        <p className="nvrpanel__lbl"><Icon name="harddrive" size={14} /> Discos</p>
        {data.hdds.length === 0 ? <p className="help-block">Sin información de discos.</p> : (
          <div className="nvrdisks">
            {data.hdds.map((h, i) => {
              const bad = h.status && h.status.toLowerCase() !== 'ok'
              const used = h.capacity - h.free
              const pct = h.capacity ? Math.round((used / h.capacity) * 100) : 0
              const hot = h.temperature != null && h.temperature >= 55
              return (
                <div className={`nvrdisk${bad ? ' is-bad' : ''}`} key={i}>
                  <div className="nvrdisk__top">
                    <span className="nvrdisk__name"><Icon name="harddrive" size={13} /> {h.name || `Disco ${i + 1}`}</span>
                    <span className={`nvrdisk__st ${bad ? 'is-bad' : 'is-ok'}`}>{bad ? <Icon name="alerttri" size={11} /> : <Icon name="check" size={11} />} {h.status || '—'}</span>
                  </div>
                  <div className="nvrdisk__bar"><i style={{ width: `${Math.min(100, pct)}%` }} className={bad ? 'is-bad' : pct >= 92 ? 'is-warn' : ''} /></div>
                  <div className="nvrdisk__meta tnum">
                    <span>{fmtGB(used)} / {fmtGB(h.capacity)}</span>
                    {h.temperature != null && <span className={`nvrdisk__temp${hot ? ' is-hot' : ''}`}><Icon name="thermometer" size={11} /> {h.temperature}°C</span>}
                    {h.property && <span className="nvrdisk__prop">{h.property}</span>}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* ── Logs críticos ── */}
      <div className="nvrpanel__sec">
        <p className="nvrpanel__lbl"><Icon name="alerttri" size={14} /> Logs críticos <span className="nvrpanel__n">{data.logs.length}</span></p>
        {data.logs.length === 0 ? <p className="help-block">Sin eventos críticos recientes en el equipo.</p> : (
          <div className="nvrlogs">
            {data.logs.map((l, i) => (
              <div className={`nvrlog nvrlog--${l.kind}`} key={i}>
                <span className="nvrlog__ic"><Icon name={l.kind === 'exception' ? 'alerttri' : l.kind === 'alarm' ? 'siren' : 'activity'} size={13} /></span>
                <span className="nvrlog__body">
                  <b>{l.title}</b>
                  {l.detail ? <small>{l.detail}</small> : null}
                </span>
                <span className="nvrlog__time tnum" title={fmtClock(l.ts)}>{fmtRel(l.ts)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Tooltip con VIDEO EN VIVO del canal ── */}
      {hover && (
        <div className="nvrlive" style={{ left: hover.x, top: hover.y }}>
          <div className="nvrlive__vid"><Go2RtcView deviceId={hover.deviceId} quality="sub" priority /></div>
          <div className="nvrlive__cap"><Icon name="video" size={11} /> Canal {hover.ch} · {hover.name || 'cámara'}</div>
        </div>
      )}
    </div>
  )
}
