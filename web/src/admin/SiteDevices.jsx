// SiteDevices — pestaña "Dispositivos" de la ficha de cliente.
// Muro de cámaras del cliente + escaneo de red para descubrir e importar equipos
// directamente a este sitio.
import { useCallback, useEffect, useState } from 'react'
import { Glass } from '../ui/primitives.jsx'
import { collectionApi, unwrap } from '../lib/adminApi.js'
import { Loading } from './_shared.jsx'
import CameraWallView from './CameraWallView.jsx'
import SiteScan from './SiteScan.jsx'

// Deriva la base de red (3 octetos) a partir de las IPs de los equipos del sitio.
function baseFrom(devices) {
  const ip = (devices || []).map((d) => d.ip).find((x) => /^\d+\.\d+\.\d+\.\d+$/.test(x || ''))
  return ip ? ip.split('.').slice(0, 3).join('.') : '192.168.99'
}

export default function SiteDevices({ siteId }) {
  const [devices, setDevices] = useState(null)
  const [allSite, setAllSite] = useState([])

  const load = useCallback(() => {
    return collectionApi('devices').list()
      .then((d) => {
        const all = unwrap(d, 'devices').filter((x) => x.siteId === siteId)
        setAllSite(all)
        setDevices(all)
      })
      .catch(() => setDevices([]))
  }, [siteId])

  useEffect(() => { let alive = true; load().then(() => { if (!alive) return }); return () => { alive = false } }, [load])

  if (!devices) return <Loading label="Cargando dispositivos…" />

  return (
    <div className="site-devices">
      <SiteScan siteId={siteId} defaultBase={baseFrom(allSite)} onImported={load} />
      {devices.length === 0
        ? <Glass className="panel"><div className="panel__body"><p className="help-block">Este cliente todavía no tiene dispositivos asociados. Usá <b>«Escanear la red»</b> arriba para descubrirlos e importarlos.</p></div></Glass>
        : <CameraWallView devices={devices} />}
    </div>
  )
}
