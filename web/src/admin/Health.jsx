// Salud de NVR/DVR — estado en vivo de los grabadores: uptime, CPU, RAM y discos.
// Datos vía ISAPI (System/status, deviceInfo, ContentMgmt/Storage).
import { useCallback, useEffect, useState } from 'react'
import { Panel, Button, Icon, Spinner } from '../ui/primitives.jsx'
import { PageHead, SectionHelp, useToast } from './_shared.jsx'
import { getNvrHealth } from '../lib/adminApi.js'

export const fmtUptime = (s) => {
  if (s == null) return '—'
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}
const fmtGB = (mb) => (mb == null ? '—' : mb >= 1024 ? `${(mb / 1024 / 1024).toFixed(2)} TB` : `${(mb / 1024).toFixed(1)} GB`)
const pctUsed = (used, total) => (total ? Math.round((used / total) * 100) : 0)

function Bar({ pct, tone }) {
  return <div className="hbar"><span className={`hbar__fill${tone ? ` hbar__fill--${tone}` : ''}`} style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} /></div>
}
const toneFor = (p) => (p >= 90 ? 'crit' : p >= 75 ? 'warn' : 'ok')

export function NvrCard({ nvr }) {
  const memPct = pctUsed(nvr.memUsed, nvr.memTotal)
  return (
    <div className={`hcard${nvr.online ? '' : ' is-off'}`}>
      <header className="hcard__head">
        <span className="hcard__name"><Icon name="device" size={16} /> {nvr.name}</span>
        <span className={`hcard__badge hcard__badge--${nvr.online ? 'ok' : 'off'}`}>
          <span className="dot" />{nvr.online ? 'En línea' : 'Sin conexión'}
        </span>
      </header>
      {nvr.online ? (
        <>
          <div className="hcard__meta">
            <span title="Modelo">{nvr.model || '—'}</span>
            <span title="Firmware">FW {nvr.firmware || '—'}</span>
            <span title="IP">{nvr.ip}</span>
          </div>
          <div className="hcard__stats">
            <div className="hstat">
              <span className="hstat__lbl"><Icon name="clock" size={13} /> Uptime</span>
              <strong className="tnum">{fmtUptime(nvr.uptime)}</strong>
            </div>
            <div className="hstat">
              <span className="hstat__lbl"><Icon name="gauge" size={13} /> CPU</span>
              <strong className="tnum">{nvr.cpu != null ? `${nvr.cpu}%` : '—'}</strong>
              <Bar pct={nvr.cpu || 0} tone={toneFor(nvr.cpu || 0)} />
            </div>
            <div className="hstat">
              <span className="hstat__lbl"><Icon name="layers" size={13} /> Memoria</span>
              <strong className="tnum">{memPct}%</strong>
              <Bar pct={memPct} tone={toneFor(memPct)} />
            </div>
          </div>
          <p className="hcard__sub"><Icon name="device" size={13} /> Discos</p>
          {nvr.hdds.length === 0 ? <p className="help-block">Sin información de discos.</p> : (
            <div className="hdds">
              {nvr.hdds.map((h, i) => {
                const used = h.capacity - h.free
                const up = pctUsed(used, h.capacity)
                const bad = h.status && h.status.toLowerCase() !== 'ok'
                return (
                  <div className="hdd" key={i}>
                    <span className="hdd__name">{h.name || `Disco ${i + 1}`}</span>
                    <span className={`hdd__st hdd__st--${bad ? 'bad' : 'ok'}`}>{h.status || '—'}</span>
                    <Bar pct={up} tone={bad ? 'crit' : toneFor(up)} />
                    <span className="hdd__cap tnum">{fmtGB(used)} / {fmtGB(h.capacity)}</span>
                  </div>
                )
              })}
            </div>
          )}
        </>
      ) : (
        <p className="help-block">No respondió por ISAPI ({nvr.ip}). Verifica red, puerto y credenciales.</p>
      )}
    </div>
  )
}

export default function Health() {
  const toast = useToast()
  const [nvrs, setNvrs] = useState(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    getNvrHealth().then((d) => setNvrs(d.nvrs || [])).catch((e) => toast(e.message || 'No se pudo cargar', 'error')).finally(() => setLoading(false))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t) }, [load])

  return (
    <div className="anim-rise">
      <PageHead title="Salud de NVR/DVR"
        subtitle="Estado en vivo de los grabadores: tiempo encendido, CPU, memoria y discos. Se actualiza cada 30 s."
        actions={<Button variant="ghost" size="sm" icon="refresh" onClick={load} disabled={loading}>Actualizar</Button>} />

      <SectionHelp id="health" icon="gauge" title="Salud de los grabadores">
        Consulta en vivo (por ISAPI) el estado de cada NVR/DVR: tiempo encendido, uso de CPU y memoria, y el estado de los discos. En CCTV 24/7 es normal que el espacio libre del disco sea 0: el grabador sobrescribe lo más viejo. Vigilá CPU/RAM altas sostenidas y discos en estado distinto de «OK».
      </SectionHelp>

      {nvrs == null ? (
        <div className="admin-center"><Spinner size={22} /><span>Consultando los NVR…</span></div>
      ) : nvrs.length === 0 ? (
        <Panel><p className="help-block">No hay NVR registrados. Agrega un NVR en Activos › Dispositivos.</p></Panel>
      ) : (
        <div className="hgrid">{nvrs.map((n) => <NvrCard key={n.id} nvr={n} />)}</div>
      )}
    </div>
  )
}
