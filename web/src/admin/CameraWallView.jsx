// CameraWallView — muro de cámaras reutilizable (ficha de cliente y Dispositivos).
// Tiles = SNAPSHOT near-live (no satura el NVR); clic en una cámara → modal con
// VIVO (HLS) + grabación (Time Machine) + overlay de analíticas. Agrupa por
// cliente (sitio) y, dentro, por NVR (zona).
import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon, Spinner, Skeleton, Badge, Segmented, Modal, Button } from '../ui/primitives.jsx'
import { collectionApi, unwrap } from '../lib/adminApi.js'
import NvrPlayback from '../components/NvrPlayback.jsx'
import { Go2RtcView, AnalyticsLegend } from '../components/CameraLive.jsx'

function CameraTile({ cam, onOpen, analytics = 0 }) {
  const boxRef = useRef(null)
  const [visible, setVisible] = useState(false)
  const [snapT, setSnapT] = useState(0)
  const [posterLoaded, setPosterLoaded] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const io = new IntersectionObserver((es) => es.forEach((e) => setVisible(e.isIntersecting)), { rootMargin: '150px' })
    io.observe(el)
    return () => io.disconnect()
  }, [])
  useEffect(() => {
    if (!visible) return
    setSnapT(Date.now())
    const t = setInterval(() => setSnapT(Date.now()), 3500)
    return () => clearInterval(t)
  }, [visible])

  return (
    <button type="button" className={`camtile${analytics > 0 ? ' has-ana' : ''}`} ref={boxRef} onClick={() => onOpen(cam)} title={cam.name}>
      <span className="camtile__media">
        {!posterLoaded && !failed && <Skeleton className="camtile__skel" w="100%" h="100%" />}
        {visible && (
          <img className="camtile__poster" alt="" loading="lazy"
               src={`/api/camera/${cam.id}/snapshot${snapT ? `?t=${snapT}` : ''}`}
               onLoad={() => { setPosterLoaded(true); setFailed(false) }}
               onError={() => { setFailed(true); setPosterLoaded(true) }} />
        )}
        {failed
          ? <span className="camtile__chip camtile__chip--err"><Icon name="alert" size={13} /></span>
          : <span className="camtile__live">EN VIVO</span>}
        {analytics > 0 && (
          <span className="camtile__ana" title={`${analytics} analítica(s) configurada(s)`}>
            <Icon name="filter" size={12} /> {analytics}
          </span>
        )}
        <span className="camtile__expand"><Icon name="search" size={14} /></span>
      </span>
      <span className="camtile__name">{cam.channel ? `#${cam.channel} ` : ''}{cam.name}</span>
    </button>
  )
}

const fmtUptime = (s) => { if (s == null) return null; const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600); return d > 0 ? `${d}d ${h}h` : `${h}h ${Math.floor((s % 3600) / 60)}m` }
const fmtRel = (ts) => { if (!ts) return null; const m = Math.floor((Date.now() - new Date(ts).getTime()) / 60000); if (m < 1) return 'recién'; if (m < 60) return `hace ${m} min`; const h = Math.floor(m / 60); return h < 24 ? `hace ${h} h` : `hace ${Math.floor(h / 24)} d` }

function InfoRow({ label, value, tone }) {
  if (value == null || value === '') return null
  return <div className="caminfo__row"><span className="caminfo__k">{label}</span><span className={`caminfo__v${tone ? ` caminfo__v--${tone}` : ''}`}>{value}</span></div>
}

export function CameraModal({ cam, onClose }) {
  const [mode, setMode] = useState('live')
  const [showAna, setShowAna] = useState(true)
  const [showInfo, setShowInfo] = useState(true)
  const [quality, setQuality] = useState('sub') // sub (SD) | main (HD)
  const [ana, setAna] = useState(null)
  const [info, setInfo] = useState(null)
  const [vres, setVres] = useState(null) // resolución del video en vivo (WxH)
  const [vAspect, setVAspect] = useState(16 / 9) // aspecto real del video (para dimensionar sin marcos)
  const synthetic = useMemo(() => ({ id: `live_${cam.id}`, source: { deviceId: cam.id, site: cam.zone }, ts: new Date().toISOString() }), [cam])

  useEffect(() => {
    let alive = true
    fetch(`/api/camera/${cam.id}/analytics`).then((r) => (r.ok ? r.json() : null)).then((d) => { if (alive) setAna(d) }).catch(() => {})
    fetch(`/api/camera/${cam.id}/info`).then((r) => (r.ok ? r.json() : null)).then((d) => { if (alive) setInfo(d) }).catch(() => {})
    return () => { alive = false }
  }, [cam.id])

  const onAspect = (s) => { const [w, h] = String(s).split('/').map((x) => parseInt(x, 10)); if (w && h) { setVres(`${w}×${h}`); setVAspect(w / h) } }
  const hasAna = ana && ana.rules && ana.rules.length > 0
  const online = mode === 'live' || (info && info.online)
  const snap = () => { const a = document.createElement('a'); a.href = `/api/camera/${cam.id}/snapshot?t=${Date.now()}`; a.download = `${cam.name || 'camara'}.jpg`; document.body.appendChild(a); a.click(); a.remove() }
  const resolution = vres || (info && info.resolution)
  // El escenario calza EXACTO al aspecto del video (alto fijo → ancho derivado),
  // así no quedan marcos negros; acotado para no desbordar la ventana.
  const stageStyle = { width: `clamp(360px, calc(var(--camh) * ${vAspect.toFixed(4)}), 74vw)` }

  return (
    <Modal open size="xl" onClose={onClose}>
      <div className="camlive">
        <div className="camlive__stage" style={stageStyle}>
          {mode === 'live'
            ? <Go2RtcView deviceId={cam.id} quality={quality} rules={showAna && hasAna ? ana.rules : null} space={ana && ana.space} onAspect={onAspect} />
            : <NvrPlayback event={synthetic} onClose={() => setMode('live')} />}

          {/* Controles flotantes arriba */}
          <div className="camlive__top">
            <Segmented value={mode} onChange={setMode} options={[{ value: 'live', label: 'En vivo' }, { value: 'rec', label: 'Grabación' }]} />
            <span className="camlive__sp" />
            {mode === 'live' && (
              <div className="camlive__qual" role="group" aria-label="Calidad">
                <button type="button" className={quality === 'sub' ? 'is-on' : ''} onClick={() => setQuality('sub')} title="Sub-stream (ligero)">SD</button>
                <button type="button" className={quality === 'main' ? 'is-on' : ''} onClick={() => setQuality('main')} title="Stream principal (HD)">HD</button>
              </div>
            )}
            {hasAna && mode === 'live' && (
              <button type="button" className={`camlive__ctl${showAna ? ' is-on' : ''}`} title="Overlay de analíticas" onClick={() => setShowAna((v) => !v)}><Icon name="filter" size={16} /></button>
            )}
            <button type="button" className="camlive__ctl" title="Capturar imagen" onClick={snap}><Icon name="camera" size={16} /></button>
            <a className="camlive__ctl" href={`/admin/devices/${cam.id}`} title="Ajustes del dispositivo"><Icon name="sliders" size={16} /></a>
            <button type="button" className={`camlive__ctl${showInfo ? ' is-on' : ''}`} title={showInfo ? 'Ocultar datos' : 'Mostrar datos'} onClick={() => setShowInfo((v) => !v)}><Icon name="doc" size={16} /></button>
            <button type="button" className="camlive__ctl camlive__ctl--close" onClick={onClose} aria-label="Cerrar"><Icon name="x" size={17} /></button>
          </div>

          {hasAna && mode === 'live' && showAna && <div className="camlive__legend"><AnalyticsLegend rules={ana.rules} /></div>}

          {/* Panel de datos OVERLAY sobre el video (degradé), ocultable */}
          {showInfo && (
            <aside className="camlive__info">
              <div className="camlive__info-head">
                <span className="campremium__name"><Icon name="camera" size={15} /> {cam.name}</span>
                <span className={`campremium__dot${online ? ' is-on' : ''}`} title={online ? 'En línea' : 'Sin señal'} />
              </div>
              {info && info.lastEvent && <p className="camlive__lastev">Últ. evento {fmtRel(info.lastEvent.ts)}</p>}
              <div className="caminfo">
                <InfoRow label="Modelo" value={info && info.model} />
                <InfoRow label="Resolución" value={resolution} />
                <InfoRow label="FPS" value={info && info.fps ? `${info.fps}` : null} />
                <InfoRow label="Bitrate" value={info && info.bitrate ? `${info.bitrate} kbps` : null} />
                <InfoRow label="Códec" value={info && info.codec} />
                <InfoRow label="Uptime" value={info && fmtUptime(info.uptime)} />
                <InfoRow label="Canal" value={cam.channel ? `#${cam.channel}` : null} />
                <InfoRow label="IP" value={(info && info.ip) || cam.ip} />
                <InfoRow label="Zona" value={cam.zone} />
              </div>
              {hasAna && <div className="camlive__info-ana"><p className="caminfo__sec">Analíticas</p><AnalyticsLegend rules={ana.rules} /></div>}
            </aside>
          )}
        </div>
      </div>
    </Modal>
  )
}

// Agrupa cámaras por cliente (sitio) → NVR (zona). Devuelve [{ siteName, zones:[{label,cams}] }].
function buildGroups(cams, siteNames) {
  const bySite = new Map()
  for (const c of cams) {
    const sName = siteNames[c.siteId] || 'Sin cliente'
    const z = c.zone || 'Sin agrupar'
    if (!bySite.has(sName)) bySite.set(sName, new Map())
    const zm = bySite.get(sName)
    if (!zm.has(z)) zm.set(z, [])
    zm.get(z).push(c)
  }
  return [...bySite.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([siteName, zm]) => ({
    siteName,
    zones: [...zm.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([label, list]) => ({
      label, cams: list.sort((a, b) => (Number(a.channel) || 0) - (Number(b.channel) || 0)),
    })),
  }))
}

export default function CameraWallView({ devices }) {
  const [siteNames, setSiteNames] = useState({})
  const [open, setOpen] = useState(null)
  const [anaFlags, setAnaFlags] = useState({})

  useEffect(() => {
    collectionApi('sites').list().then((d) => {
      const m = {}; unwrap(d, 'sites').forEach((s) => { m[s.id] = s.name }); setSiteNames(m)
    }).catch(() => {})
  }, [])

  const cams = useMemo(() => (devices || []).filter((d) => d.type !== 'nvr'), [devices])

  // Marca qué cámaras tienen analíticas dibujadas (un POST bulk, cacheado en server).
  useEffect(() => {
    if (!cams.length) return
    let alive = true
    fetch('/api/cameras/analytics-flags', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: cams.map((c) => c.id) }) })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive && d) setAnaFlags(d.flags || {}) })
      .catch(() => {})
    return () => { alive = false }
  }, [cams])
  const nvrCount = useMemo(() => (devices || []).filter((d) => d.type === 'nvr').length, [devices])
  const groups = useMemo(() => buildGroups(cams, siteNames), [cams, siteNames])
  const multiSite = groups.length > 1

  if (!cams.length) {
    return <p className="help-block">No hay cámaras para mostrar.</p>
  }

  return (
    <div className="sitedev anim-rise">
      <div className="sitedev__summary">
        <span className="qchip"><Icon name="camera" size={14} /><strong className="tnum">{cams.length}</strong> cámaras</span>
        {nvrCount > 0 && <span className="qchip"><Icon name="device" size={14} /><strong className="tnum">{nvrCount}</strong> NVR</span>}
        <span className="sitedev__hint"><Icon name="bolt" size={13} /> Vista near-live (snapshot); clic en una cámara para verla en vivo + grabación.</span>
      </div>

      {groups.map((site) => (
        <div className="camsite" key={site.siteName}>
          {multiSite && <h3 className="camsite__head"><Icon name="building" size={16} /> {site.siteName}</h3>}
          {site.zones.map((z) => (
            <section className="camgroup" key={z.label}>
              <header className="camgroup__head">
                <span className="camgroup__title"><Icon name="device" size={15} /> {z.label}</span>
                <Badge tone="neutral">{z.cams.length} cámaras</Badge>
              </header>
              <div className="camgrid">
                {z.cams.map((c) => <CameraTile key={c.id} cam={c} onOpen={setOpen} analytics={anaFlags[c.id] || 0} />)}
              </div>
            </section>
          ))}
        </div>
      ))}

      {open && <CameraModal cam={open} onClose={() => setOpen(null)} />}
    </div>
  )
}
