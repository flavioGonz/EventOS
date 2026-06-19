// Salud del SITIO: tarjetas de salud de sus NVR/DVR + roster de cámaras con su
// estado en línea (barrido throttle por snapshot, para no saturar el NVR).
import { useEffect, useMemo, useState } from 'react'
import { Icon, Spinner, Button } from '../ui/primitives.jsx'
import { collectionApi, unwrap, getNvrHealth } from '../lib/adminApi.js'
import { NvrCard } from './Health.jsx'

export default function SiteHealth({ siteId }) {
  const [devices, setDevices] = useState(null)
  const [nvrs, setNvrs] = useState(null)
  const [online, setOnline] = useState({})   // deviceId -> bool
  const [sweeping, setSweeping] = useState(false)

  useEffect(() => {
    collectionApi('devices').list().then((d) => setDevices(unwrap(d, 'devices'))).catch(() => setDevices([]))
    getNvrHealth().then((d) => setNvrs(d.nvrs || [])).catch(() => setNvrs([]))
  }, [])

  const siteDevs = useMemo(() => (devices || []).filter((d) => d.siteId === siteId), [devices, siteId])
  const nvrIds = useMemo(() => new Set(siteDevs.filter((d) => d.type === 'nvr').map((d) => d.id)), [siteDevs])
  const siteNvrs = (nvrs || []).filter((n) => nvrIds.has(n.id))
  const cams = useMemo(() => siteDevs.filter((d) => d.type !== 'nvr' && d.type !== 'alarm'), [siteDevs])

  // Barrido de estado: snapshot por cámara (vía NVR, cacheado) con concurrencia 3.
  // El /info no sirve aquí (web ISAPI de cámaras tras NVR da 401 con clave del NVR).
  const sweep = (list) => {
    if (!list.length) return
    setSweeping(true); setOnline({})
    let i = 0, active = 0, cancelled = false
    const next = () => {
      if (i >= list.length && active === 0) { setSweeping(false); return }
      while (active < 3 && i < list.length) {
        const c = list[i++]; active++
        fetch(`/api/camera/${c.id}/snapshot?probe=1`, { cache: 'no-store' })
          .then((r) => { if (!cancelled) setOnline((o) => ({ ...o, [c.id]: r.ok })) })
          .catch(() => { if (!cancelled) setOnline((o) => ({ ...o, [c.id]: false })) })
          .finally(() => { active--; if (!cancelled) next() })
      }
    }
    next()
    return () => { cancelled = true }
  }

  // Auto-barrido una vez cuando se conocen las cámaras del sitio.
  useEffect(() => { if (cams.length) return sweep(cams) /* eslint-disable-next-line */ }, [siteId, cams.length])

  const onCount = cams.filter((c) => online[c.id] === true).length
  const offCount = cams.filter((c) => online[c.id] === false).length

  if (devices === null) return <div className="admin-center"><Spinner size={20} /><span>Cargando…</span></div>

  return (
    <div className="sitehealth">
      <p className="section-label"><Icon name="device" size={14} /> NVR / DVR</p>
      {nvrs === null
        ? <div className="admin-center"><Spinner size={18} /><span>Consultando los NVR…</span></div>
        : siteNvrs.length === 0
          ? <p className="help-block">Este sitio no tiene NVR/DVR registrados.</p>
          : <div className="hgrid">{siteNvrs.map((n) => <NvrCard key={n.id} nvr={n} />)}</div>}

      <div className="sitehealth__camhead">
        <p className="section-label"><Icon name="camera" size={14} /> Cámaras <span className="muted">· {cams.length}</span>
          {!sweeping && (onCount + offCount) > 0 && <span className="sitehealth__sum"> · <b className="ok">{onCount} en línea</b>{offCount ? <> · <b className="off">{offCount} sin señal</b></> : null}</span>}
        </p>
        <Button variant="ghost" size="sm" icon="refresh" disabled={sweeping || !cams.length} onClick={() => sweep(cams)}>
          {sweeping ? 'Comprobando…' : 'Comprobar'}
        </Button>
      </div>
      {cams.length === 0
        ? <p className="help-block">Sin cámaras en este sitio.</p>
        : (
          <div className="sitehealth__cams">
            {cams.map((c) => {
              const st = online[c.id]
              return (
                <div className="sitehealth__cam" key={c.id}>
                  <span className={`onlinedot ${st === undefined ? 'is-unknown' : st ? 'is-on' : 'is-off'}`}
                    title={st === undefined ? 'Comprobando…' : st ? 'En línea' : 'Sin señal'} />
                  <span className="sitehealth__cam-name">{c.name}</span>
                  <span className="sitehealth__cam-meta">{c.channel ? `#${c.channel}` : '—'} · {c.ip || '—'}</span>
                </div>
              )
            })}
          </div>
        )}
    </div>
  )
}
