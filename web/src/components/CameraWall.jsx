import { useEffect, useMemo, useState } from 'react'
import CameraTile from './CameraTile.jsx'
import { Icon, IconButton, Segmented, Spinner, EmptyState } from '../ui/primitives.jsx'
import { formatTime } from '../lib/format.js'

// CameraWall — "Muro de video" del Centro de Verificación en Vivo.
//
// Al abrir, consulta GET /api/cameras?site=<sitio del evento> y arma la lista
// de cámaras del sitio. Identifica la CÁMARA FUENTE (la que disparó el evento):
//   1. por nombre (deviceName/name, sin distinguir mayúsculas)
//   2. por IP
//   3. por canal (channel)
//   4. si nada casa → sintetiza una "fuente" desde el propio evento
//      (nombre = event.source.deviceName, snapshot = event.media.snapshotUrl).
//
// Vistas conmutables: Hero (1) / 2×2 / 3×3. La fuente siempre va primero y
// queda marcada con anillo de acento + tag "EVENTO". Click en un satélite lo
// destaca (swap al hero).

const norm = (v) => (v == null ? '' : String(v).trim().toLowerCase())

function eventSite(event) {
  const s = (event && event.source) || {}
  return s.site || event.site || event.zone || ''
}

// Sintetiza un "tile fuente" desde el propio evento cuando no hay cámara real.
function synthSourceCamera(event) {
  const s = (event && event.source) || {}
  const realId = s.deviceId && /^dev_/.test(String(s.deviceId)) ? s.deviceId : `__event__${event.id}`
  return {
    id: realId,
    name: s.deviceName || s.deviceId || 'Cámara del evento',
    zone: event.zone || s.site || '',
    site: s.site || '',
    ip: s.ip,
    channel: s.channel,
    streamUrl: (event.media && event.media.streamUrl) || null,
    snapshotUrl: (event.media && event.media.snapshotUrl) || null,
    __synthetic: true,
  }
}

// Devuelve el índice de la cámara fuente dentro de `cams`, o -1.
function matchSourceIndex(cams, event) {
  const s = (event && event.source) || {}
  const wantId = s.deviceId
  if (wantId) { const i = cams.findIndex((c) => c.id === wantId); if (i >= 0) return i }
  const wantName = norm(s.deviceName || s.deviceId)
  const wantIp = norm(s.ip)
  const wantCh = s.channel

  if (wantName) {
    const i = cams.findIndex((c) => norm(c.name) === wantName)
    if (i >= 0) return i
  }
  if (wantIp) {
    const i = cams.findIndex((c) => norm(c.ip) === wantIp)
    if (i >= 0) return i
  }
  if (wantCh !== undefined && wantCh !== null && wantCh !== '') {
    const i = cams.findIndex((c) => String(c.channel) === String(wantCh))
    if (i >= 0) return i
  }
  return -1
}

export default function CameraWall({ event }) {
  const [cameras, setCameras] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [view, setView] = useState('hero') // hero | 2x2 | 3x3
  const [spotId, setSpotId] = useState(null)
  const [reloadKey, setReloadKey] = useState(0)

  const site = eventSite(event)

  // Cargar cámaras del sitio.
  useEffect(() => {
    let alive = true
    setLoading(true)
    setError('')
    const url = `/api/cameras?site=${encodeURIComponent(site || '')}`
    fetch(url, { headers: { Accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data) => {
        if (!alive) return
        setCameras(Array.isArray(data && data.cameras) ? data.cameras : [])
        setLoading(false)
      })
      .catch((e) => {
        if (!alive) return
        setError(e.message || 'No se pudieron cargar las cámaras')
        setCameras([])
        setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [site, event && event.id, reloadKey])

  // Lista ordenada: fuente primero (real o sintética), luego satélites.
  const { ordered, sourceId } = useMemo(() => {
    const list = cameras.slice()
    const idx = matchSourceIndex(list, event)
    let srcCam
    if (idx >= 0) {
      srcCam = list.splice(idx, 1)[0]
    } else {
      srcCam = synthSourceCamera(event)
    }
    return { ordered: [srcCam, ...list], sourceId: srcCam.id }
  }, [cameras, event])

  // Cámara destacada en el hero (la fuente por defecto).
  const heroId = spotId || sourceId
  const heroCam = ordered.find((c) => c.id === heroId) || ordered[0]

  const p = event && (event.priority ?? 5)
  const evTs = event && event.ts ? formatTime(event.ts) : null
  // Id de la regla/zona que disparó el evento (para resaltarla en el overlay).
  const triggerId = (event && event.raw && (event.raw.regionID || event.raw.RegionID || event.raw.lineID)) || null

  const viewOptions = [
    { value: 'hero', label: 'Hero' },
    { value: '2x2', label: '2×2' },
    { value: '3x3', label: '3×3' },
  ]

  const gridCount = view === '2x2' ? 4 : view === '3x3' ? 9 : 1
  const gridCams = ordered.slice(0, gridCount)

  return (
    <div className="camwall">
      <div className="camwall__bar">
        <span className="camwall__count tnum">
          <Icon name="video" size={13} />
          {ordered.length}
        </span>
        <Segmented value={view} onChange={setView} options={viewOptions} />
        <IconButton
          icon="refresh"
          size="sm"
          label="Actualizar feeds"
          onClick={() => setReloadKey((k) => k + 1)}
        />
      </div>

      {loading ? (
        <div className="camwall__state">
          <Spinner size={22} />
          <span>Cargando cámaras del sitio…</span>
        </div>
      ) : error ? (
        <div className="camwall__state">
          <EmptyState icon="alert" title="Error al cargar cámaras">
            {error}
          </EmptyState>
        </div>
      ) : view === 'hero' ? (
        <div className="camwall__hero-wrap">
          <div className="camwall__hero">
            <CameraTile
              camera={heroCam}
              isSource={heroCam.id === sourceId}
              live
              size="hero"
              priority={p}
              eventTs={evTs}
              highlightId={heroCam.id === sourceId ? triggerId : null}
            />
          </div>

          {ordered.length > 1 ? (
            <div className="camwall__strip">
              {ordered.map((cam) => (
                <button
                  key={cam.id}
                  type="button"
                  className={`camwall__thumb ${cam.id === heroId ? 'is-active' : ''} ${
                    cam.id === sourceId ? 'is-source' : ''
                  }`}
                  onClick={() => setSpotId(cam.id)}
                  title={cam.name}
                >
                  <CameraTile
                    camera={cam}
                    isSource={cam.id === sourceId}
                    live={cam.id === heroId}
                    size="sm"
                    priority={p}
                  />
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : (
        <div className={`camwall__mosaic camwall__mosaic--${view}`}>
          {gridCams.map((cam) => (
            <CameraTile
              key={cam.id}
              camera={cam}
              isSource={cam.id === sourceId}
              live
              size="md"
              priority={p}
              eventTs={cam.id === sourceId ? evTs : null}
              highlightId={cam.id === sourceId ? triggerId : null}
              showSpotlight
              onSpotlight={() => {
                setSpotId(cam.id)
                setView('hero')
              }}
            />
          ))}
        </div>
      )}
    </div>
  )
}
