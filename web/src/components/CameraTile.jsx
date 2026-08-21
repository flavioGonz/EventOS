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
  alert = null,          // {count} si este canal tuvo eventos recientes → overlay rojo
  liveGrid = false,      // permite vivo también en mosaico (md), no solo en el hero
  quality = 'sub',       // 'main' (hasta 4 canales) | 'sub' (más canales) — rendimiento
  bare = false,          // celda limpia: cuadrado redondeado, sin barras/título (hover)
  hotspots = null,       // seguimiento visual: [{id,x,y,label,target,count}] sobre el video
  onFollowHotspot = null,// clic en un hotspot → saltar a esa cámara (seguimiento de escena)
}) {
  const [failed, setFailed] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [bust, setBust] = useState(() => Date.now())
  // Aspecto REAL del video en vivo (reportado por el reproductor). En el Hero, el
  // tile adopta este aspecto → el video llena el cuadro y el overlay de analíticas
  // coincide exacto (sin desfase), en vez de estirarse sobre todo el ancho.
  const [liveAspect, setLiveAspect] = useState(null)

  // Cámara respaldada por un dispositivo real → pipeline nuevo (live HLS + snapshot
  // ISAPI del server). Si no, se usan las URLs configuradas (streamUrl/snapshotUrl).
  const deviceId = isRealDeviceId(camera && camera.id) ? camera.id : null
  const streamUrl = camera && camera.streamUrl
  const snapshotUrl = (camera && camera.snapshotUrl) || (deviceId ? `/api/camera/${deviceId}/snapshot` : null)
  const hls = isHls(streamUrl)

  // El visor principal (hero) de una cámara-dispositivo va EN VIVO (HLS). El
  // mosaico usa snapshot salvo que se pida vivo en grilla (liveGrid) — entonces
  // también reproduce vivo (sub) por canal. Analíticas solo en la fuente.
  const useDeviceLive = !!deviceId && !streamUrl && !!live && (size === 'hero' || (liveGrid && size === 'md'))
  // Analíticas dibujadas: SOLO en el Hero de la fuente. En el mosaico (bare) el
  // video va "contain" (con franjas) y la capa de analíticas no puede alinear con
  // el recuadro real → se veían cruzadas/desalineadas entre celdas. Por eso el
  // dibujo de zonas/líneas queda reservado al Hero, donde el tile adopta el
  // aspecto del video y coincide exacto.
  // Analíticas dibujadas: en el Hero (grande, con aspecto adoptado) para CUALQUIER
  // cámara que se suba al recuadro — no solo la fuente — así el operador ve las
  // líneas/zonas sobre el vivo mientras busca. En el mosaico (bare) quedan off.
  const anaOn = (!!isSource || size === 'hero') && !bare
  const ana = useCameraAnalytics(deviceId, anaOn)
  const anaRules = ana && ana.rules && ana.rules.length > 0 ? ana.rules : null

  const usingStream = !!streamUrl && !failed
  const usingSnapshot = !usingStream && !useDeviceLive && !!snapshotUrl && !failed

  // Reiniciar error/carga cuando cambia la fuente.
  useEffect(() => {
    setFailed(false)
    setLoaded(false)
    setLiveAspect(null)
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
    media = <Go2RtcView deviceId={deviceId} quality={quality} priority={size === 'hero'} rules={anaOn ? anaRules : null} space={(ana && ana.space) || 1000} highlightId={isSource ? highlightId : null} onAspect={setLiveAspect} />
    caption = anaOn && anaRules ? 'en vivo · analíticas' : 'en vivo'
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
  // En el Hero con vivo, el tile toma el aspecto real del stream → sin desfase.
  const fitHero = size === 'hero' && useDeviceLive && !!liveAspect

  return (
    <div
      className={`camtile glass camtile--${size} ${isSource ? 'is-source' : ''} ${
        hasFeed ? 'has-feed' : 'no-feed'
      }${fitHero ? ' camtile--fit' : ''}${alert ? ' camtile--alerted' : ''}${bare ? ' camtile--bare' : ''}`}
      style={fitHero ? { aspectRatio: liveAspect } : undefined}
    >
      <div className="camtile__frame">
        {media}
        {hasFeed && !loaded && !failed && !useDeviceLive && <Skeleton className="camtile__skel" w="100%" h="100%" />}
      </div>

      {/* Overlay de alerta: el canal tuvo eventos en los últimos minutos → borde
          rojo pulsante + chip, para que el operador note actividad de un vistazo. */}
      {alert ? (
        <>
          <span className="camtile__alertring" aria-hidden="true" />
          <span className="camtile__alertchip" title={`${alert.count} evento(s) recientes en este canal`}>
            <Icon name="alert" size={11} /> {alert.count > 1 ? `${alert.count} eventos` : 'Evento'}
          </span>
        </>
      ) : null}

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

      {/* Seguimiento visual: iconos de cámaras vecinas posados sobre el video (solo
          lectura acá; se posicionan en /wall). Clic → salta a esa cámara. Badge = nº
          de eventos de esa cámara en los últimos 15 min. */}
      {hotspots && hotspots.length > 0 && (
        <div className="camtile__hots">
          {hotspots.map((h) => (
            <button key={h.id} type="button"
              className={`wallhot${h.count > 0 ? ' has-events' : ''}`}
              style={{ left: `${h.x * 100}%`, top: `${h.y * 100}%` }}
              title={`Ir a ${h.label || 'cámara'}${h.count > 0 ? ` · ${h.count} evento(s) en 15 min` : ''}`}
              onClick={(e) => { e.stopPropagation(); if (onFollowHotspot) onFollowHotspot(h.target) }}>
              <Icon name="camera" size={13} />
              <span className="wallhot__lbl">{h.label || '—'}</span>
              {h.count > 0 && <span className="wallhot__badge" aria-label={`${h.count} eventos recientes`}>{h.count > 99 ? '99+' : h.count}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
