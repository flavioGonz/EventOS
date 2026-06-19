// CameraLive — pieza compartida de video de cámara (admin y popup del operador):
// hook de vivo RTSP→HLS por el server con semáforo global, y overlay de las
// analíticas (líneas/zonas) dibujadas sobre el video en coords normalizadas.
import { useEffect, useRef, useState } from 'react'
import Hls from 'hls.js'
import { Spinner, Icon } from '../ui/primitives.jsx'
import { VideoRTC } from '../lib/video-rtc.js'

// Registra el web component <video-stream> de go2rtc (WebRTC → MSE → fallback).
if (typeof window !== 'undefined' && window.customElements && !customElements.get('video-stream')) {
  try { customElements.define('video-stream', VideoRTC) } catch { /* ya definido */ }
}

// Reproductor en vivo por HLS TRANSCODIFICADO en el server (ffmpeg→H264 con SPS
// válido). Las cámaras fisheye de cesimco emiten un H264 con SPS malformado (crop
// values invalid / sps_id out of range) que NINGÚN decodificador de navegador
// acepta con remux `copy` (PIPELINE_ERROR_DECODE, por MSE y por WebRTC); el
// re-encode lo sanea. HLS viaja por HTTP (puerto 80, vía nginx) → robusto desde
// cualquier red, sin ICE/UDP. `src` = sesión go2rtc ya registrada (grabación).
export function Go2RtcView({ deviceId, src, rules = null, space = 1000, highlightId = null, onAspect = null, quality = 'sub' }) {
  // Camino A (deviceId, sin src): VIVO por HLS transcodificado.
  // Camino B (src): grabación por go2rtc/MSE (NvrPlayback registra el stream).
  const useGo2 = !!src && !deviceId
  if (useGo2) return <Go2RtcMseView src={src} rules={rules} space={space} highlightId={highlightId} onAspect={onAspect} />
  return <HlsLiveView deviceId={deviceId} rules={rules} space={space} highlightId={highlightId} onAspect={onAspect} quality={quality} />
}

// VIVO por MJPEG (multipart de snapshots ISAPI ~10 fps). El H264 RTSP de este NVR
// llega ~50% corrupto y NO se puede limpiar (relleno=gris; descarte=basura sin SPS),
// pero el snapshot JPEG es PERFECTO. IMPORTANTE: Chrome NO repinta un <img>
// multipart al ritmo real (coalesce los frames → se ve ~1 cada 2s), así que
// parseamos el stream nosotros y pintamos cada JPEG en un <canvas> (decode con
// createImageBitmap) → fluido de verdad a la tasa recibida.
function MjpegCanvas({ deviceId, onFirst, onAspect, onError, quality = 'sub' }) {
  const canvasRef = useRef(null)
  useEffect(() => {
    if (!deviceId) return
    const ctrl = new AbortController()
    let stop = false
    const canvas = canvasRef.current
    const concat = (a, b) => { const c = new Uint8Array(a.length + b.length); c.set(a); c.set(b, a.length); return c }
    const findSeq = (arr, seq, from = 0) => {
      outer: for (let i = from; i <= arr.length - seq.length; i++) {
        for (let j = 0; j < seq.length; j++) if (arr[i + j] !== seq[j]) continue outer
        return i
      }
      return -1
    }
    ;(async () => {
      let res
      try { res = await fetch(`/api/camera/${deviceId}/mjpeg?q=${quality}&k=${Date.now()}`, { signal: ctrl.signal }) } catch { if (!stop && onError) onError(); return }
      if (!res.ok || !res.body) { if (!stop && onError) onError(); return }
      const reader = res.body.getReader()
      const ctx = canvas ? canvas.getContext('2d') : null
      let buf = new Uint8Array(0)
      let first = true
      try {
        while (!stop) {
          const { done, value } = await reader.read()
          if (done) break
          if (value) buf = concat(buf, value)
          // Extrae TODOS los frames completos del buffer pero queda solo con el
          // ÚLTIMO: si la decodificación va por detrás de la red, descartamos los
          // atrasados → siempre se pinta el frame más nuevo (baja latencia, menos CPU).
          let latest = null
          for (;;) {
            const he = findSeq(buf, [13, 10, 13, 10]) // fin de cabeceras de la parte
            if (he < 0) break
            let header = ''
            for (let i = 0; i < he && i < 400; i++) header += String.fromCharCode(buf[i])
            const m = /Content-Length:\s*(\d+)/i.exec(header)
            if (!m) { buf = buf.subarray(he + 4); continue }
            const len = +m[1]; const start = he + 4
            if (buf.length < start + len) break // espera el JPEG completo
            latest = buf.slice(start, start + len)
            buf = buf.subarray(start + len)
          }
          if (latest) {
            try {
              const bmp = await createImageBitmap(new Blob([latest], { type: 'image/jpeg' }))
              if (ctx) {
                if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
                  canvas.width = bmp.width; canvas.height = bmp.height
                  if (onAspect) onAspect(`${bmp.width} / ${bmp.height}`)
                }
                ctx.drawImage(bmp, 0, 0)
              }
              if (bmp.close) bmp.close()
              if (first) { first = false; if (onFirst) onFirst() }
            } catch { /* frame ilegible: salta */ }
          }
          if (buf.length > 4_000_000) buf = buf.subarray(buf.length - 1_000_000) // tope de seguridad
        }
      } catch { if (!stop && onError) onError() }
      if (!stop && onError) onError() // el stream terminó → reintenta
    })()
    return () => { stop = true; ctrl.abort() }
  }, [deviceId])
  return <canvas ref={canvasRef} className="go2view__canvas" />
}

// Lee el modo de vivo (mjpeg/hls) de la config global, cacheado entre instancias.
let _videoCfgCache = null
function useLiveMode() {
  const [mode, setMode] = useState((_videoCfgCache && _videoCfgCache.liveMode) || 'mjpeg')
  useEffect(() => {
    if (_videoCfgCache) { setMode(_videoCfgCache.liveMode || 'mjpeg'); return }
    let alive = true
    fetch('/api/video-settings').then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d) { _videoCfgCache = d; if (alive) setMode(d.liveMode || 'mjpeg') } }).catch(() => {})
    return () => { alive = false }
  }, [])
  return mode
}

// Dispatcher: si la cámara tiene RTSP DIRECTO disponible (camIp via VPN), usa
// go2rtc/MSE = video LIMPIO a 25fps. Si no (404), cae al MJPEG por el NVR.
function HlsLiveView(props) {
  const { deviceId, quality = 'sub' } = props
  const mode = useLiveMode()
  const [direct, setDirect] = useState(undefined) // undefined=probando | name | null
  useEffect(() => {
    if (!deviceId) { setDirect(null); return }
    let alive = true
    setDirect(undefined)
    fetch('/api/live-direct', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId, quality }) })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive) setDirect(d && d.name ? d.name : null) })
      .catch(() => { if (alive) setDirect(null) })
    return () => { alive = false }
  }, [deviceId, quality])

  if (direct === undefined) return <div className="go2view"><div className="go2view__badge"><Spinner size={12} /> conectando vivo…</div></div>
  if (direct) return <DirectLiveView streamName={direct} {...props} />
  return mode === 'hls' ? <HlsVideoLive {...props} /> : <MjpegLive {...props} />
}

// Vivo DIRECTO de la cámara por go2rtc/MSE (stream limpio, 25fps). Póster snapshot
// instantáneo + overlay de analíticas.
function DirectLiveView({ streamName, deviceId, rules, space, highlightId, onAspect }) {
  const elRef = useRef(null)
  const [state, setState] = useState('connecting')
  useEffect(() => {
    const el = elRef.current
    if (!el || !streamName) return
    el.background = false
    el.mode = 'mse'
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    el.src = `${proto}://${window.location.host}/go2rtc/api/ws?src=${encodeURIComponent(streamName)}`
    setState('connecting')
    let v = null
    const onMeta = () => { if (onAspect && v && v.videoWidth && v.videoHeight) onAspect(`${v.videoWidth} / ${v.videoHeight}`) }
    const onPlay = () => { setState('playing'); onMeta() } // el aspecto REAL es el del video, no el del póster
    const onErr = () => setState((s) => (s === 'playing' ? s : 'error'))
    let tries = 0
    const t = setInterval(() => {
      if (el.video) {
        v = el.video
        v.addEventListener('playing', onPlay); v.addEventListener('loadeddata', onPlay)
        v.addEventListener('loadedmetadata', onMeta); v.addEventListener('error', onErr)
        if (v.videoWidth) onMeta()
        clearInterval(t)
      } else if (++tries > 60) clearInterval(t)
    }, 100)
    return () => {
      clearInterval(t)
      if (v) { v.removeEventListener('playing', onPlay); v.removeEventListener('loadeddata', onPlay); v.removeEventListener('loadedmetadata', onMeta); v.removeEventListener('error', onErr) }
      try { el.src = '' } catch { /* noop */ }
    }
  }, [streamName])
  const [snapT, setSnapT] = useState(0)
  useEffect(() => {
    if (state === 'playing' || !deviceId) return
    setSnapT(Date.now())
    const id = setInterval(() => setSnapT(Date.now()), 700)
    return () => clearInterval(id)
  }, [state, deviceId])
  const playing = state === 'playing'
  return (
    <div className={`go2view${playing ? ' go2view--playing' : ''}`}>
      {/* El aspecto lo fija el VIDEO (onMeta), no el póster (que puede ser de otra
          resolución que el subflujo) → evita marcos negros por desajuste. */}
      {!playing && deviceId && (
        <img className="go2view__snap" alt="" src={`/api/camera/${deviceId}/snapshot${snapT ? `?t=${snapT}` : ''}`} />
      )}
      <video-stream ref={elRef}></video-stream>
      {rules && rules.length > 0 && <AnalyticsOverlay rules={rules} space={space} highlightId={highlightId} />}
      {!playing && (
        <div className={`go2view__badge${state === 'error' ? ' is-err' : ''}`}>
          {state === 'error' ? 'reintentando…' : <><Spinner size={12} /> conectando vivo…</>}
        </div>
      )}
    </div>
  )
}

// Vivo por HLS H264 transcodificado (modo 'hls'; útil cuando se apague H.264+).
function HlsVideoLive({ deviceId, rules, space, highlightId, onAspect }) {
  const videoRef = useRef(null)
  const { phase } = useLiveHlsOn(videoRef, deviceId, 'sub', (w, h) => { if (onAspect && w && h) onAspect(`${w} / ${h}`) })
  const playing = phase === 'playing'
  const [snapT, setSnapT] = useState(0)
  useEffect(() => {
    if (playing || !deviceId) return
    setSnapT(Date.now())
    const id = setInterval(() => setSnapT(Date.now()), 500)
    return () => clearInterval(id)
  }, [playing, deviceId])
  if (!deviceId) return null
  return (
    <div className={`go2view${playing ? ' go2view--playing' : ''}`}>
      {!playing && (
        <img className="go2view__snap" alt="" src={`/api/camera/${deviceId}/snapshot${snapT ? `?t=${snapT}` : ''}`}
             onLoad={(e) => { const n = e.currentTarget; if (onAspect && n.naturalWidth && n.naturalHeight) onAspect(`${n.naturalWidth} / ${n.naturalHeight}`) }} />
      )}
      <video ref={videoRef} className="go2view__video" muted autoPlay playsInline />
      {rules && rules.length > 0 && <AnalyticsOverlay rules={rules} space={space} highlightId={highlightId} />}
      {!playing && (
        <div className={`go2view__badge${phase === 'error' ? ' is-err' : ''}`}>
          {phase === 'error' ? 'NEAR-LIVE' : <><Spinner size={12} /> conectando vivo…</>}
        </div>
      )}
    </div>
  )
}

function MjpegLive({ deviceId, rules, space, highlightId, onAspect, quality = 'sub' }) {
  const [state, setState] = useState('connecting') // connecting | playing | error
  const [streamKey, setStreamKey] = useState(0)
  const [snapT, setSnapT] = useState(0)

  useEffect(() => { setState('connecting'); setStreamKey(Date.now()) }, [deviceId, quality])

  // Póster snapshot instantáneo mientras el primer frame MJPEG decodifica.
  useEffect(() => {
    if (state === 'playing' || !deviceId) return
    setSnapT(Date.now())
    const id = setInterval(() => setSnapT(Date.now()), 500)
    return () => clearInterval(id)
  }, [state, deviceId])

  if (!deviceId) return null
  const playing = state === 'playing'
  return (
    <div className={`go2view${playing ? ' go2view--playing' : ''}`}>
      {!playing && (
        <img className="go2view__snap" alt="" src={`/api/camera/${deviceId}/snapshot${snapT ? `?t=${snapT}` : ''}`}
             onLoad={(e) => { const n = e.currentTarget; if (onAspect && n.naturalWidth && n.naturalHeight) onAspect(`${n.naturalWidth} / ${n.naturalHeight}`) }} />
      )}
      <MjpegCanvas key={streamKey} deviceId={deviceId} quality={quality}
        onFirst={() => setState('playing')}
        onAspect={onAspect}
        onError={() => { setState('error'); setTimeout(() => setStreamKey(Date.now()), 1500) }} />
      {rules && rules.length > 0 && <AnalyticsOverlay rules={rules} space={space} highlightId={highlightId} />}
      {!playing && (
        <div className={`go2view__badge${state === 'error' ? ' is-err' : ''}`}>
          {state === 'error' ? 'reintentando…' : <><Spinner size={12} /> conectando vivo…</>}
        </div>
      )}
    </div>
  )
}

// Adjunta una sesión HLS de vivo (transcodificada) a un <video> dado. Maneja el
// arranque "calentando" (m3u8 placeholder) reintentando, y reporta el aspecto.
function useLiveHlsOn(videoRef, deviceId, quality, onAspect) {
  const [phase, setPhase] = useState('idle') // idle|loading|playing|error
  useEffect(() => {
    if (!deviceId) { setPhase('idle'); return }
    let alive = true
    const hlsRef = { h: null }
    const sidRef = { id: null }
    setPhase('loading')
    const attach = (url) => {
      const v = videoRef.current
      if (!v) return
      const onMeta = () => { if (onAspect && v.videoWidth && v.videoHeight) onAspect(v.videoWidth, v.videoHeight) }
      v.addEventListener('loadedmetadata', onMeta)
      if (Hls.isSupported()) {
        const hls = new Hls({ liveSyncDurationCount: 2, lowLatencyMode: true, backBufferLength: 6,
          manifestLoadingMaxRetry: 40, manifestLoadingRetryDelay: 600, levelLoadingMaxRetry: 40, fragLoadingMaxRetry: 8 })
        hlsRef.h = hls
        hls.loadSource(url); hls.attachMedia(v)
        hls.on(Hls.Events.MANIFEST_PARSED, () => v.play().catch(() => {}))
        hls.on(Hls.Events.FRAG_BUFFERED, () => { if (alive) setPhase('playing') })
        hls.on(Hls.Events.ERROR, (_e, d) => { if (d.fatal && d.type !== Hls.ErrorTypes.NETWORK_ERROR && alive) setPhase('error') })
      } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
        v.src = url; v.play().catch(() => {}); setPhase('playing')
      } else setPhase('error')
    }
    ;(async () => {
      try {
        const r = await fetch('/api/live', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId, quality }) })
        const d = await r.json()
        if (!r.ok) throw new Error(d.message || 'live')
        sidRef.id = d.id
        if (alive) attach(d.url)
      } catch { if (alive) setPhase('error') }
    })()
    const ka = setInterval(() => { if (sidRef.id) fetch(`/api/playback/${sidRef.id}/keepalive`, { method: 'POST' }).catch(() => {}) }, 120000)
    return () => {
      alive = false
      clearInterval(ka)
      if (hlsRef.h) { try { hlsRef.h.destroy() } catch { /* noop */ } }
      if (sidRef.id) fetch(`/api/playback/${sidRef.id}`, { method: 'DELETE' }).catch(() => {})
    }
  }, [deviceId, quality])
  return { phase }
}

// Grabación vía go2rtc/MSE (la sesión `src` ya está registrada y transcodificada).
function Go2RtcMseView({ src, rules, space, highlightId, onAspect }) {
  const elRef = useRef(null)
  const [state, setState] = useState('connecting')
  useEffect(() => {
    const el = elRef.current
    if (!el || !src) return
    el.background = false
    el.mode = 'mse'
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    el.src = `${proto}://${window.location.host}/go2rtc/api/ws?src=${encodeURIComponent(src)}`
    setState('connecting')
    let v = null
    const onMeta = () => { if (onAspect && v && v.videoWidth && v.videoHeight) onAspect(`${v.videoWidth} / ${v.videoHeight}`) }
    const onPlay = () => { setState('playing'); onMeta() } // el aspecto REAL es el del video, no el del póster
    const onErr = () => setState((s) => (s === 'playing' ? s : 'error'))
    let tries = 0
    const t = setInterval(() => {
      if (el.video) {
        v = el.video
        v.addEventListener('playing', onPlay); v.addEventListener('loadeddata', onPlay)
        v.addEventListener('loadedmetadata', onMeta); v.addEventListener('error', onErr)
        if (v.videoWidth) onMeta()
        clearInterval(t)
      } else if (++tries > 60) clearInterval(t)
    }, 100)
    return () => {
      clearInterval(t)
      if (v) { v.removeEventListener('playing', onPlay); v.removeEventListener('loadeddata', onPlay); v.removeEventListener('loadedmetadata', onMeta); v.removeEventListener('error', onErr) }
      try { el.src = '' } catch { /* noop */ }
    }
  }, [src])
  const playing = state === 'playing'
  return (
    <div className={`go2view${playing ? ' go2view--playing' : ''}`}>
      <video-stream ref={elRef}></video-stream>
      {rules && rules.length > 0 && <AnalyticsOverlay rules={rules} space={space} highlightId={highlightId} />}
      {!playing && (
        <div className={`go2view__badge${state === 'error' ? ' is-err' : ''}`}>
          {state === 'error' ? 'Error de reproducción' : <><Spinner size={12} /> cargando…</>}
        </div>
      )}
    </div>
  )
}

// ── Semáforo global de vivos concurrentes (protege NVR + CPU/banda) ──────────
export const MAX_LIVE = 6
let liveActive = 0
const liveQueue = []
function acquireLive() {
  if (liveActive < MAX_LIVE) { liveActive++; return Promise.resolve() }
  return new Promise((resolve) => liveQueue.push(resolve))
}
function releaseLive() {
  const next = liveQueue.shift()
  if (next) next()
  else liveActive = Math.max(0, liveActive - 1)
}

// Vivo RTSP→HLS. priority=true salta el semáforo (vista deliberada / hero).
export function useLiveHls(deviceId, quality, enabled, priority = false) {
  const videoRef = useRef(null)
  const hlsRef = useRef(null)
  const sidRef = useRef(null)
  const slotRef = useRef(false)
  const [phase, setPhase] = useState('idle') // idle|queued|loading|playing|error

  useEffect(() => {
    if (!enabled || !deviceId) return
    let alive = true
    setPhase(priority ? 'loading' : 'queued')

    const attach = (url) => {
      const v = videoRef.current
      if (!v) return
      if (Hls.isSupported()) {
        const hls = new Hls({ liveSyncDurationCount: 2, lowLatencyMode: true, backBufferLength: 6,
          manifestLoadingMaxRetry: 30, manifestLoadingRetryDelay: 600, levelLoadingMaxRetry: 30, fragLoadingMaxRetry: 6 })
        hlsRef.current = hls
        hls.loadSource(url); hls.attachMedia(v)
        hls.on(Hls.Events.MANIFEST_PARSED, () => { v.play().catch(() => {}) })
        hls.on(Hls.Events.FRAG_BUFFERED, () => { if (alive) setPhase('playing') })
        hls.on(Hls.Events.ERROR, (_e, data) => { if (data.fatal && data.type !== Hls.ErrorTypes.NETWORK_ERROR && alive) setPhase('error') })
      } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
        v.src = url; v.play().catch(() => {}); setPhase('playing')
      } else setPhase('error')
    }

    ;(async () => {
      if (!priority) { await acquireLive(); if (!alive) { releaseLive(); return } slotRef.current = true }
      if (!alive) return
      setPhase('loading')
      try {
        const r = await fetch('/api/live', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId, quality }) })
        const d = await r.json()
        if (!r.ok) throw new Error(d.message || 'live')
        sidRef.current = d.id
        if (alive) attach(d.url)
      } catch { if (alive) setPhase('error') }
    })()

    const ka = setInterval(() => { if (sidRef.current) fetch(`/api/playback/${sidRef.current}/keepalive`, { method: 'POST' }).catch(() => {}) }, 120000)

    return () => {
      alive = false
      clearInterval(ka)
      if (hlsRef.current) { try { hlsRef.current.destroy() } catch {} hlsRef.current = null }
      if (sidRef.current) { fetch(`/api/playback/${sidRef.current}`, { method: 'DELETE' }).catch(() => {}); sidRef.current = null }
      if (slotRef.current) { slotRef.current = false; releaseLive() }
    }
  }, [deviceId, quality, enabled, priority])

  return { videoRef, phase }
}

// Carga las analíticas dibujadas de una cámara (por id de dispositivo).
export function useCameraAnalytics(deviceId, enabled = true) {
  const [ana, setAna] = useState(null)
  useEffect(() => {
    if (!enabled || !deviceId) { setAna(null); return }
    let alive = true
    fetch(`/api/camera/${deviceId}/analytics`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive) setAna(d) })
      .catch(() => {})
    return () => { alive = false }
  }, [deviceId, enabled])
  return ana
}

// ¿Es un id de dispositivo real (no una fuente sintética del evento)?
export function isRealDeviceId(id) { return typeof id === 'string' && id.length > 0 && !id.startsWith('__') }

export const ANA_LABEL = { line: 'Cruce de línea', field: 'Intrusión', entrance: 'Entrada a zona', exiting: 'Salida de zona' }

// Dibuja las reglas sobre el video. Hikvision: origen abajo-izquierda → invierte Y.
export function AnalyticsOverlay({ rules, space = 1000, highlightId = null }) {
  if (!rules || !rules.length) return null
  const fy = (y) => space - y
  return (
    <svg className="anov" viewBox={`0 0 ${space} ${space}`} preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <marker id="anar" markerWidth="9" markerHeight="9" refX="6.5" refY="3" orient="auto">
          <path d="M0,0 L7,3 L0,6 Z" fill="#f5b945" />
        </marker>
      </defs>
      {rules.map((r, i) => {
        const hot = highlightId != null && String(r.id) === String(highlightId)
        return r.type === 'line' ? (
          <line key={i} className={`anov__line${hot ? ' is-hot' : ''}`} markerEnd="url(#anar)"
            x1={r.points[0].x} y1={fy(r.points[0].y)} x2={r.points[1].x} y2={fy(r.points[1].y)} />
        ) : (
          <polygon key={i} className={`anov__zone anov__zone--${r.type}${hot ? ' is-hot' : ''}`}
            points={r.points.map((p) => `${p.x},${fy(p.y)}`).join(' ')} />
        )
      })}
    </svg>
  )
}

// Reproductor de vivo "encajado": el contenedor adopta el aspecto real del stream
// (para que el overlay de analíticas alinee exacto), con póster instantáneo
// (snapshot ISAPI) y estado de conexión. Reutilizable en admin y popup.
export function FittedLive({ deviceId, quality = 'main', priority = true, rules = null, space = 1000, highlightId = null, controls = true }) {
  const { videoRef, phase } = useLiveHls(deviceId, quality, true, priority)
  const [aspect, setAspect] = useState('16 / 9')
  const onMeta = (e) => { const v = e.currentTarget; if (v.videoWidth && v.videoHeight) setAspect(`${v.videoWidth} / ${v.videoHeight}`) }
  const playing = phase === 'playing'
  return (
    <div className="fitlive" style={{ aspectRatio: aspect }}>
      {!playing && <img className="fitlive__poster" src={`/api/camera/${deviceId}/snapshot`} alt="" onError={(e) => { e.currentTarget.style.opacity = 0 }} />}
      <video ref={videoRef} className={`fitlive__video${playing ? ' is-on' : ''}`} controls={controls} muted playsInline onLoadedMetadata={onMeta} />
      {playing && rules && rules.length > 0 && <AnalyticsOverlay rules={rules} space={space} highlightId={highlightId} />}
      {!playing && (
        <div className={`fitlive__ov${phase === 'error' ? ' is-err' : ''}`}>
          {phase === 'error'
            ? <><span className="fitlive__dot fitlive__dot--err" />Sin vivo</>
            : <><Spinner size={16} />Conectando…</>}
        </div>
      )}
    </div>
  )
}

export function AnalyticsLegend({ rules }) {
  const counts = rules.reduce((a, r) => { a[r.type] = (a[r.type] || 0) + 1; return a }, {})
  return (
    <div className="ana-legend">
      {Object.entries(counts).map(([t, n]) => (
        <span key={t} className={`ana-pill ana-pill--${t}`}>{ANA_LABEL[t] || t} · {n}</span>
      ))}
    </div>
  )
}
