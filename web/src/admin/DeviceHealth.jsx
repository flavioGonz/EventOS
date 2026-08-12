// Salud de UN dispositivo: NVR → tarjeta de salud completa (uptime/CPU/RAM/discos);
// cámara → panel de estado en vivo (online, modelo, FW, resolución, fps, bitrate,
// códec, uptime, última alerta) + snapshot.
import { useEffect, useState } from 'react'
import { Icon, Spinner } from '../ui/primitives.jsx'
import { getNvrHealth } from '../lib/adminApi.js'
import { NvrCard, fmtUptime } from './Health.jsx'

const fmtRel = (ts) => { if (!ts) return null; const m = Math.floor((Date.now() - new Date(ts).getTime()) / 60000); if (m < 1) return 'recién'; if (m < 60) return `hace ${m} min`; const h = Math.floor(m / 60); return h < 24 ? `hace ${h} h` : `hace ${Math.floor(h / 24)} d` }
const vendorLabel = (v) => { if (!v) return 'este equipo'; const s = String(v).toLowerCase(); if (s.includes('tiandy')) return 'Tiandy'; if (s.includes('hik')) return 'Hikvision'; if (s.includes('dahua')) return 'Dahua'; return v }

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
  // Portero/intercom Akuvox: salud propia (modelo/FW/SIP/LAN) por su HTTP API.
  const ak = info && info.akuvox
  if (ak) {
    const sipTone = (st) => (st === 'registered' ? 'is-on' : st === 'registering' ? 'is-warn' : 'is-off')
    const sipLbl = (st) => (st === 'registered' ? 'Registrado' : st === 'registering' ? 'Registrando' : 'Sin registro')
    return (
      <div className="devhealth">
        <div className="devhealth__snap">
          <img src={`/api/camera/${device.id}/snapshot?t=${snapT}`} alt="" onError={(e) => { e.currentTarget.style.opacity = .12 }} />
          <span className="devhealth__live is-on">EN LÍNEA</span>
        </div>
        <div className="devhealth__info">
          <div className="devhealth__status">
            <span className="campremium__dot is-on" />
            <strong>Portero en línea</strong>
            <span className="devhealth__srcbadge">Akuvox · HTTP API</span>
            {info.lastEvent && <span className="devhealth__lastev">Últ. evento {fmtRel(info.lastEvent.ts)}</span>}
          </div>
          <div className="caminfo">
            <HRow k="Modelo" v={ak.model} />
            <HRow k="Firmware" v={ak.firmware} />
            <HRow k="Hardware" v={ak.hardware} />
            <HRow k="MAC" v={ak.mac} />
            <HRow k="Uptime" v={ak.uptimeSec != null ? fmtUptime(ak.uptimeSec) : ak.uptime} />
            <HRow k="IP" v={(ak.lan && ak.lan.ip) || (info && info.ip) || device.ip} />
            {ak.lan && <HRow k="Gateway" v={ak.lan.gateway} />}
            {ak.lan && <HRow k="Máscara" v={ak.lan.mask} />}
            {ak.lan && <HRow k="DNS" v={ak.lan.dns} />}
          </div>
          <p className="section-label u-mt-12"><Icon name="phone" size={13} /> Cuentas SIP</p>
          {(ak.sip && ak.sip.length) ? (
            <div className="caminfo">
              {ak.sip.map((a) => (
                <div key={a.account} className="caminfo__row">
                  <span className="caminfo__k">Cuenta {a.account}{a.user ? ` · ${a.user}` : ''}</span>
                  <span className="caminfo__v"><span className="devhealth__srv">{a.server || '—'}</span> <span className={`sipbadge ${sipTone(a.state)}`}>{sipLbl(a.state)}</span></span>
                </div>
              ))}
            </div>
          ) : <p className="help-block">Sin cuentas SIP configuradas en el portero.</p>}
        </div>
      </div>
    )
  }
  const online = !!(info && info.online)
  // Fuente de la salud: 'isapi' = métricas completas (Hikvision); 'rtsp' = solo
  // confirmamos alcance (Tiandy/ONVIF/otros que no exponen ISAPI); null = sin señal.
  const via = info && info.via
  const limited = online && via === 'rtsp'
  const vlabel = vendorLabel(info && info.vendor)
  return (
    <div className="devhealth">
      <div className="devhealth__snap">
        <img src={`/api/camera/${device.id}/snapshot?t=${snapT}`} alt="" onError={(e) => { e.currentTarget.style.opacity = .15 }} />
        <span className={`devhealth__live${online ? ' is-on' : ''}${limited ? ' is-limited' : ''}`}>{online ? (limited ? 'ALCANZABLE' : 'EN LÍNEA') : 'SIN SEÑAL'}</span>
      </div>
      <div className="devhealth__info">
        <div className="devhealth__status">
          <span className={`campremium__dot${online ? ' is-on' : ''}`} />
          <strong>{online ? (limited ? 'Alcanzable' : 'En línea') : 'Sin señal'}</strong>
          {limited && <span className="devhealth__srcbadge">{vlabel} · sin ISAPI</span>}
          {info && info.lastEvent && <span className="devhealth__lastev">Últ. alerta {fmtRel(info.lastEvent.ts)}</span>}
        </div>
        <div className="caminfo">
          <HRow k="Marca" v={limited ? vlabel : (info && info.model)} />
          {!limited && <HRow k="Firmware" v={info && info.firmware} />}
          {!limited && <HRow k="Resolución" v={info && info.resolution} />}
          {!limited && <HRow k="FPS" v={info && info.fps ? `${info.fps}` : null} />}
          {!limited && <HRow k="Bitrate" v={info && info.bitrate ? `${info.bitrate} kbps` : null} />}
          {!limited && <HRow k="Códec" v={info && info.codec} />}
          {!limited && <HRow k="Uptime" v={info && info.uptime != null ? fmtUptime(info.uptime) : null} />}
          <HRow k="Canal" v={device.channel ? `#${device.channel}` : null} />
          <HRow k="IP" v={(info && info.ip) || device.ip} />
          {limited && <HRow k="Estado" v="Puerto de video respondiendo (RTSP)" />}
        </div>
        {limited && <p className="help-block devhealth__note">Salud limitada: {vlabel} no expone métricas por ISAPI, así que solo confirmamos que el equipo está alcanzable (responde el puerto de video). Modelo, firmware, uptime, CPU y discos no están disponibles para este equipo.</p>}
        {!online && <p className="help-block">No respondió por ISAPI ni por RTSP. Verificá red, puerto y credenciales en la pestaña Datos.</p>}
      </div>
    </div>
  )
}
