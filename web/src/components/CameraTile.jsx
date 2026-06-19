import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Icon, PriorityDot, Skeleton } from '../ui/primitives.jsx'
import { Go2RtcView, useCameraAnalytics, isRealDeviceId } from './CameraLive.jsx'

// CameraTile — visor de una sola cámara, reutilizable en hero y mosaico.
//
// Cadena de medios (fallback):
//   1. camera.streamUrl
//        · termina en .m3u8  → <video> (HLS nativo; en navegadores sin
//          soporte no reproduce — se muestra el caption "stream HLS").
//        · cualquier otro    → <img> (MJPEG / image stream).
//   2. camera.snapshotUrl → <img> con polling (cache-bust ?t=) cada ~1500 ms,
//        sólo cuando `live` es true (hero / tiles visibles del mosaico).
//   3. nada → placeholder de vidrio con enlace a Admin · Dispositivos.
//
// Cualquier onError de <img>/<video> cae al placeholder.

const POLL_MS = 1500

function isHls(url) {
  return typeof url === 'string' && url.split('?')[0].toLowerCase().endsWith('.m3u8')
}

export default function CameraTile({
  camera,
  isSource = false,
  live = false,
  size = 'md',
  priority,
  eventTs,
  highlightId = null,
  onSpotlight,
  showSpotlight = false,
}) {
  const [failed, setFailed] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [bust, setBust] = useState(() => Date.now())

  // Cámara respaldada por un dispositivo real → pipeline nuevo (live HLS + snapshot
  // ISAPI del server). Si no, se usan las URLs configuradas (streamUrl/snapshotUrl).
  const deviceId = isRealDeviceId(camera && camera.id) ? camera.id : null
  const streamUrl = camera && camera.streamUrl
  const snapshotUrl = (camera && camera.snapshotUrl) || (deviceId ? `/api/camera/${deviceId}/snapshot` : null)
  const hls = isHls(streamUrl)

  // El visor principal (hero) de una cámara-dispositivo va EN VIVO (HLS). Las
  // miniaturas/mosaico usan snapshot (más liviano). Analíticas solo en la fuente.
  const useDeviceLive = !!deviceId && !streamUrl && !!live && size === 'hero'
  const ana = useCameraAnalytics(deviceId, !!isSource)
  const anaRules = ana && ana.rules && ana.rules.length > 0 ? ana.rules : null

  const usingStream = !!streamUrl && !failed
  const usingSnapshot = !usingStream && !useDeviceLive && !!snapshotUrl && !failed

  // Reiniciar error/carga cuando cambia la fuente.
  useEffect(() => {
    setFailed(false)
    setLoaded(false)
  }, [streamUrl, snapshotUrl, camera && camera.id])

  // Polling del snapshot: sólo si está "en vivo" y visible.
  useEffect(() => {
    if (!usingSnapshot || !live) return
    setBust(Date.now())
    const t = setInterval(() => setBust(Date.now()), POLL_MS)
    return () => clearInterval(t)
  }, [usingSnapshot, live, snapshotUrl])

  const name = (camera && camera.name) || 'Cámara'
  const zone = camera && (camera.zone || camera.site)

  let media
  let caption = null

  if (useDeviceLive) {
    media = <Go2RtcView deviceId={deviceId} rules={isSource ? anaRules : null} space={(ana && ana.space) || 1000} highlightId={isSource ? highlightId : null} />
    caption = isSource && anaRules ? 'en vivo · analíticas' : 'en vivo'
  } else if (usingStream && hls) {
    media = (
      <video
        className="camtile__media"
        src={streamUrl}
        controls
        muted
        autoPlay
        playsInline
        onLoadedData={() => setLoaded(true)}
        onError={() => setFailed(true)}
      />
    )
    caption = 'stream HLS'
  } else if (usingStream) {
    media = (
      <img
        className="camtile__media"
        src={streamUrl}
        alt={name}
        onLoad={() => setLoaded(true)}
        onError={() => setFailed(true)}
      />
    )
    caption = 'en vivo'
  } else if (usingSnapshot) {
    const sep = snapshotUrl.includes('?') ? '&' : '?'
    media = (
      <img
        className="camtile__media"
        src={`${snapshotUrl}${sep}t=${bust}`}
        alt={name}
        onLoad={() => setLoaded(true)}
        onError={() => setFailed(true)}
      />
    )
    caption = 'en vivo · snapshot'
  } else {
    media = (
      <div className="camtile__ph">
        <Icon name="camera" size={size === 'sm' ? 22 : 30} />
        <span className="camtile__ph-name">{name}</span>
        <span className="camtile__ph-msg">
          Sin fuente de video —{' '}
          <Link to="/admin/devices" className="camtile__ph-link">
            configúrala en Admin · Dispositivos
          </Link>
        </span>
      </div>
    )
  }

  const hasFeed = usingStream || usingSnapshot || useDeviceLive

  return (
    <div
      className={`camtile glass camtile--${size} ${isSource ? 'is-source' : ''} ${
        hasFeed ? 'has-feed' : 'no-feed'
      }`}
    >
      <div className="camtile__frame">
        {media}
        {hasFeed && !loaded && !failed && !useDeviceLive && <Skeleton className="camtile__skel" w="100%" h="100%" />}
      </div>

      {/* Overlay superior: LIVE + tag EVENTO */}
      <div className="camtile__top">
        {hasFeed && live ? (
          <span className="camtile__live">
            <span className="camtile__live-dot" aria-hidden="true" />
            LIVE
          </span>
        ) : null}
        {isSource ? (
          <span className="camtile__evtag">
            <PriorityDot p={priority ?? 5} size={9} />
            EVENTO
          </span>
        ) : null}
        <span className="camtile__top-spacer" />
        {showSpotlight && onSpotlight ? (
          <button
            type="button"
            className="camtile__spot"
            onClick={onSpotlight}
            aria-label="Destacar cámara"
            title="Destacar en el visor principal"
          >
            <Icon name="expand" size={15} />
          </button>
        ) : null}
      </div>

      {/* Overlay inferior: nombre + zona + caption */}
      <div className="camtile__bottom">
        <span className="camtile__name">{name}</span>
        {zone ? <span className="camtile__zone">{zone}</span> : null}
        <span className="camtile__bottom-spacer" />
        {caption ? <span className="camtile__caption">{caption}</span> : null}
        {isSource && eventTs ? <span className="camtile__caption">{eventTs}</span> : null}
      </div>
    </div>
  )
}
