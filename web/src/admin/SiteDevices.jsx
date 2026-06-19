// SiteDevices — pestaña "Dispositivos" de la ficha de cliente.
// Muestra el muro de cámaras del cliente (snapshot near-live + vivo/grabación al
// abrir) reutilizando CameraWallView, filtrado al sitio.
import { useEffect, useState } from 'react'
import { Glass } from '../ui/primitives.jsx'
import { collectionApi, unwrap } from '../lib/adminApi.js'
import { Loading } from './_shared.jsx'
import CameraWallView from './CameraWallView.jsx'

export default function SiteDevices({ siteId }) {
  const [devices, setDevices] = useState(null)

  useEffect(() => {
    let alive = true
    collectionApi('devices').list()
      .then((d) => { if (alive) setDevices(unwrap(d, 'devices').filter((x) => x.siteId === siteId)) })
      .catch(() => { if (alive) setDevices([]) })
    return () => { alive = false }
  }, [siteId])

  if (!devices) return <Loading label="Cargando dispositivos…" />
  if (!devices.length) {
    return <Glass className="panel"><div className="panel__body"><p className="help-block">Este cliente todavía no tiene dispositivos asociados.</p></div></Glass>
  }
  return <CameraWallView devices={devices} />
}
