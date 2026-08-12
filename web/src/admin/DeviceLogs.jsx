// DeviceLogs — pestaña "Logs" de un dispositivo. Fusiona el registro NATIVO del
// equipo (porteros Akuvox: aperturas doorlog + llamadas calllog) con los eventos
// de EventOS de ese mismo dispositivo, en una línea de tiempo única. El registro
// del portero se cachea en el server (~60s) porque el E16C devuelve todo (~5MB).
import { useEffect, useState } from 'react'
import { Icon, Spinner, Button, Badge } from '../ui/primitives.jsx'
import { formatTime, timeAgo } from '../lib/format.js'

const KIND = {
  door:  { icon: 'route', tone: 'ok',     label: 'Apertura' },
  call:  { icon: 'phone', tone: 'accent', label: 'Llamada' },
  event: { icon: 'bell',  tone: 'warn',   label: 'Evento' },
}
const okStatus = (s) => /succ|éxito|exito|ok|received|dial/i.test(String(s || ''))

export default function DeviceLogs({ device, isNew }) {
  const [data, setData] = useState(undefined)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    if (isNew || !device || !device.id) return
    let alive = true
    setData(undefined)
    fetch(`/api/device/${device.id}/logs?limit=150`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive) setData(d || { entries: [] }) })
      .catch(() => { if (alive) setData({ entries: [] }) })
    return () => { alive = false }
  }, [device && device.id, isNew, reloadKey])

  if (isNew) return <p className="help-block">Guardá el dispositivo para ver su registro.</p>
  if (data === undefined) return <div className="admin-center"><Spinner size={20} /><span>Cargando registro del dispositivo… (el portero puede tardar unos segundos)</span></div>

  const entries = data.entries || []
  return (
    <div className="devlogs">
      <div className="devlogs__bar">
        <span className="devlogs__count"><Icon name="rules" size={14} /> {entries.length} registros {data.native ? '· portero + eventos' : '· eventos EventOS'}</span>
        <span className="devlogs__spacer" />
        <Button variant="ghost" size="sm" icon="refresh" onClick={() => setReloadKey((k) => k + 1)}>Actualizar</Button>
      </div>
      {data.error && <p className="help-block devlogs__err"><Icon name="alert" size={13} /> No se pudo leer el registro nativo del equipo: {data.error}</p>}
      {entries.length === 0 ? (
        <p className="help-block">Sin registros para este dispositivo todavía. Los eventos de EventOS y (en porteros) las aperturas y llamadas aparecen acá.</p>
      ) : (
        <ul className="devlogs__list">
          {entries.map((e, i) => {
            const k = KIND[e.kind] || KIND.event
            return (
              <li key={i} className={`devlog devlog--${e.source}`}>
                <span className={`devlog__ic t-${k.tone}`}><Icon name={k.icon} size={14} /></span>
                <span className="devlog__time tnum">{formatTime(e.ts)}</span>
                <span className="devlog__title">{e.title || k.label}</span>
                {e.status ? <Badge tone={okStatus(e.status) ? 'ok' : 'crit'}>{e.status}</Badge> : null}
                {e.detail ? <span className="devlog__detail">{e.detail}</span> : null}
                <span className="devlog__spacer" />
                <span className={`devlog__src devlog__src--${e.source}`}>{e.source === 'device' ? 'equipo' : 'EventOS'}</span>
                <span className="devlog__ago tnum">{timeAgo(e.ts)}</span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
