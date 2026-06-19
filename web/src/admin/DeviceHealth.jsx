// Salud de UN dispositivo: NVR → tarjeta de salud completa (uptime/CPU/RAM/discos);
// cámara → panel de estado en vivo (online, modelo, FW, resolución, fps, bitrate,
// códec, uptime, última alerta) + snapshot.
import { useEffect, useState } from 'react'
import { Icon, Spinner } from '../ui/primitives.jsx'
import { getNvrHealth } from '../lib/adminApi.js'
import { NvrCard, fmtUptime } from './Health.jsx'

const fmtRel = (ts) => { if (!ts) return null; const m = Math.floor((Date.now() - new Date(ts).getTime()) / 60000); if (m < 1) return 'recién'; if (m < 60) return `hace ${m} min`; const h = Math.floor(m / 60); return h < 24 ? `hace ${h} h` : `hace ${Math.floor(h / 24)} d` }

function HRow({ k, v }) {
  if (v == null || v === '') return null
  return <div className="caminfo__row"><span className="caminfo__k">{k}</span><span className="caminfo__v">{v}</span></div>
}

export default function DeviceHealth({ device, isNew }) {
  const isNvr = device && device.type === 'nvr'
  const [nvr, setNvr] = useState(undefined)
  const [info, setInfo] = useState(undefined)
  const [snapT, setSnapT] = useState(Date.now())

  useEffect(() => {
    if (isNew || !device || !device.id) return
    let alive = true
    if (isNvr) {
      getNvrHealth().then((d) => { if (alive) setNvr((d.nvrs || []).find((n) => n.id === device.id) || null) }).catch(() => { if (alive) setNvr(null) })
    } else {
      const load = () => fetch(`/api/camera/${device.id}/info`).then((r) => (r.ok ? r.json() : null)).then((d) => { if (alive) setInfo(d || null) }).catch(() => { if (alive) setInfo(null) })
      load(); const t = setInterval(load, 20000); return () => { alive = false; clearInterval(t) }
    }
    return () => { alive = false }
  }, [device, isNvr, isNew])

  // refresca el snapshot del póster cada 5s
  useEffect(() => { if (isNew || isNvr) return; const t = setInterval(() => setSnapT(Date.now()), 5000); return () => clearInterval(t) }, [isNew, isNvr])

  if (isNew) return <p className="help-block">Guardá el dispositivo para ver su salud en vivo.</p>

  if (isNvr) {
    if (nvr === undefined) return <div className="admin-center"><Spinner size={20} /><span>Consultando el NVR…</span></div>
    if (!nvr) return <p className="help-block">Sin datos de salud para este NVR (¿responde por ISAPI?).</p>
    return <div className="hgrid">{<NvrCard nvr={nvr} />}</div>
  }

  // Cámara
  if (info === undefined) return <div className="admin-center"><Spinner size={20} /><span>Consultando la cámara…</span></div>
  const online = !!(info && info.online)
  return (
    <div className="devhealth">
      <div className="devhealth__snap">
        <img src={`/api/camera/${device.id}/snapshot?t=${snapT}`} alt="" onError={(e) => { e.currentTarget.style.opacity = .15 }} />
        <span className={`devhealth__live${online ? ' is-on' : ''}`}>{online ? 'EN LÍNEA' : 'SIN SEÑAL'}</span>
      </div>
      <div className="devhealth__info">
        <div className="devhealth__status">
          <span className={`campremium__dot${online ? ' is-on' : ''}`} />
          <strong>{online ? 'En línea' : 'Sin señal'}</strong>
          {info && info.lastEvent && <span className="devhealth__lastev">Últ. alerta {fmtRel(info.lastEvent.ts)}</span>}
        </div>
        <div className="caminfo">
          <HRow k="Modelo" v={info && info.model} />
          <HRow k="Firmware" v={info && info.firmware} />
          <HRow k="Resolución" v={info && info.resolution} />
          <HRow k="FPS" v={info && info.fps ? `${info.fps}` : null} />
          <HRow k="Bitrate" v={info && info.bitrate ? `${info.bitrate} kbps` : null} />
          <HRow k="Códec" v={info && info.codec} />
          <HRow k="Uptime" v={info && info.uptime != null ? fmtUptime(info.uptime) : null} />
          <HRow k="Canal" v={device.channel ? `#${device.channel}` : null} />
          <HRow k="IP" v={(info && info.ip) || device.ip} />
        </div>
        {!online && <p className="help-block">No respondió por ISAPI. Verificá red, puerto ISAPI y credenciales en la pestaña Datos.</p>}
      </div>
    </div>
  )
}
