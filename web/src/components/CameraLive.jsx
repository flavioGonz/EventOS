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
export function Go2RtcView({ deviceId, src, rules = null, space = 1000, highlightId = null, onAspect = null, onPoster = null, quality = 'sub', priority = false }) {
  // Camino A (deviceId, sin src): VIVO por HLS transcodificado.
  // Camino B (src): grabación por go2rtc/MSE (NvrPlayback registra el stream).
  // `onPoster` avisa apenas se muestra el snapshot-póster (antes de que conecte el
  // vivo) → el que consume puede quitar su skeleton sin esperar al video.
  const useGo2 = !!src && !deviceId
  if (useGo2) return <Go2RtcMseView src={src} rules={rules} space={space} highlightId={highlightId} onAspect={onAspect} />
  return <HlsLiveView deviceId={deviceId} rules={rules} space={space} highlightId={highlightId} onAspect={onAspect} onPoster={onPoster} quality={quality} priority={priority} />
}

// Refresco del snapshot-póster mientras NO hay vivo: una foto rápida y luego cada
// ~10 min (placeholder liviano, no un loop de snapshots). El vivo carga por detrás.
const POSTER_REFRESH_MS = 600000

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
// También ajusta el tope de streams concurrentes (liveConcurrency) → así el sistema
// ESCALA a la capacidad del NVR sin recompilar: se sube desde Admin · Video.
let _videoCfgCache = null
function applyLiveCfg(d) {
  if (d && Number(d.liveConcurrency) > 0) setMaxLive(Number(d.liveConcurrency))
}
function useLiveMode() {
  const [mode, setMode] = useState((_videoCfgCache && _videoCfgCache.liveMode) || 'mjpeg')
  useEffect(() => {
    if (_videoCfgCache) { setMode(_videoCfgCache.liveMode || 'mjpeg'); applyLiveCfg(_videoCfgCache); return }
    let alive = true
    fetch('/api/video-settings').then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d) { _videoCfgCache = d; applyLiveCfg(d); if (alive) setMode(d.liveMode || 'mjpeg') } }).catch(() => {})
    return () => { alive = false }
  }, [])
  return mode
}

// Tile en ESPERA de turno de vivo (semáforo lleno): en vez de dejarlo NEGRO con "en
// cola", mostramos el snapshot del canal refrescando cada ~2.5 s. El operador VE la
// cámara en la grilla —sin movimiento pleno— y NO gasta un decodificador de video, que
// es exactamente lo que satura GPU/compositor y memoria en grillas densas (3×3) sobre
// hardware modesto (p.ej. Intel UHD 630, 16 GB). Así se ven TODAS las cámaras sin colgar
// el cliente: las primeras N van a vivo pleno (tope configurable) y el resto, en foto viva.
function QueuedSnapshot({ deviceId }) {
  const [t, setT] = useState(() => Date.now())
  useEffect(() => {
    if (!deviceId) return
    const id = setInterval(() => setT(Date.now()), 2500)
    return () => clearInterval(id)
  }, [deviceId])
  if (!deviceId) return <div className="go2view"><div className="go2view__badge">en espera…</div></div>
  return (
    <div className="go2view">
      <img className="go2view__snap" alt="" src={`/api/camera/${deviceId}/snapshot?t=${t}`} />
      <div className="go2view__badge"><Icon name="camera" size={11} /> en espera · foto</div>
    </div>
  )
}

// Dispatcher: si la cámara tiene RTSP DIRECTO disponible (camIp via VPN), usa
// go2rtc/MSE = video LIMPIO a 25fps. Si no (404), cae al MJPEG por el NVR.
function HlsLiveView(props) {
  const { deviceId, priority = false } = props
  // Calidad EFECTIVA: respeta el override global del cliente de escritorio para la
  // grilla (SD/HD), salvo en vistas priority (hero) que mantienen lo pedido.
  const quality = effQuality(props.quality || 'sub', priority)
  const mode = useLiveMode()
  const [direct, setDirect] = useState(undefined) // undefined=probando | name | null
  const [queued, setQueued] = useState(false)     // esperando turno de vivo (semáforo lleno)
  // Si el stream DIRECTO por go2rtc falla de forma persistente (p. ej. stream.mp4
  // devuelve 500 porque el restream del canal no arranca), degradamos al camino
  // por NVR (MJPEG/HLS) en vez de reintentar para siempre un directo muerto.
  const [directDead, setDirectDead] = useState(false)
  // SEMÁFORO: todas las cámaras del sitio pueden salir por el MISMO NVR, que limita
  // conexiones RTSP concurrentes. Sin tope, una grilla 3×3 abre 9 streams a la vez
  // → el NVR rechaza los de más y go2rtc devuelve 500. El Hero (priority) salta la
  // cola; el mosaico toma turnos (MAX_LIVE) y el resto queda "en cola".
  useEffect(() => {
    if (!deviceId) { setDirect(null); return }
    let alive = true, slot = false
    setDirect(undefined)
    setDirectDead(false)
    ;(async () => {
      if (!priority) {
        setQueued(true)
        await acquireLive()
        if (!alive) { releaseLive(); return }
        slot = true
        setQueued(false)
      }
      try {
        const r = await fetch('/api/live-direct', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId, quality }) })
        const d = r.ok ? await r.json() : null
        if (alive) setDirect(d && d.name ? d.name : null)
      } catch { if (alive) setDirect(null) }
    })()
    return () => { alive = false; setQueued(false); if (slot) releaseLive() }
  }, [deviceId, quality]) // eslint-disable-line react-hooks/exhaustive-deps

  // Esperando turno de vivo → foto viva (no negro), sin decodificar video.
  if (queued) return <QueuedSnapshot deviceId={deviceId} />
  if (direct === undefined) return <div className="go2view"><div className="go2view__badge"><Spinner size={12} /> conectando vivo…</div></div>
  if (direct && !directDead) return <DirectLiveView streamName={direct} onDead={() => setDirectDead(true)} {...props} />
  // FALLBACK. En el HERO (priority) el flujo es SIEMPRE video, NUNCA fotos: si no hay
  // directo go2rtc, usamos HLS transcodificado (H264 fluido), jamás el MJPEG (que son
  // snapshots del servidor de fotos). El MJPEG queda sólo para el mosaico.
  if (priority) return <HlsVideoLive {...props} />
  return mode === 'hls' ? <HlsVideoLive {...props} /> : <MjpegLive {...props} />
}

// Vivo DIRECTO de la cámara por go2rtc/MSE (stream limpio, 25fps). Póster snapshot
// instantáneo + overlay de analíticas.
function DirectLiveView({ streamName, deviceId, rules, space, highlightId, onAspect, onPoster = null, onDead = null, priority = false }) {
  const elRef = useRef(null)
  useVisibilityPause(elRef)
  const [state, setState] = useState('connecting')
  // Vivo por fMP4 progresivo (HTTP GET) — robusto detrás de proxy TLS: no depende
  // del WebSocket de go2rtc (que algunos reverse-proxies no reenvían). El stream ya
  // está registrado en go2rtc por /live-direct; acá sólo lo consumimos.
  useEffect(() => {
    const el = elRef.current
    if (!el || !streamName) return
    setState('connecting')
    const url = `/go2rtc/api/stream.mp4?src=${encodeURIComponent(streamName)}`
    let retry, wd, lastT = 0, lastAdvance = Date.now()
    let errStreak = 0, everPlayed = false, gaveUp = false
    const arm = () => { lastT = 0; lastAdvance = Date.now(); try { el.src = url; el.load && el.load(); const p = el.play && el.play(); if (p && p.catch) p.catch(() => {}) } catch { /* noop */ } }
    const onMeta = () => { if (onAspect && el.videoWidth && el.videoHeight) onAspect(`${el.videoWidth} / ${el.videoHeight}`) }
    const onPlay = () => { everPlayed = true; errStreak = 0; setState('playing'); lastAdvance = Date.now(); onMeta() }
    // Reintenta el directo, PERO si nunca reprodujo y falla varias veces seguidas,
    // se rinde y avisa (onDead) para que el dispatcher caiga al NVR/MJPEG.
    const onErr = () => {
      setState((s) => (s === 'playing' ? s : 'error'))
      clearTimeout(retry)
      if (gaveUp) return
      errStreak += 1
      // Paciencia: el transcode del NVR (main) puede tardar ~10-15 s en dar el
      // primer segmento. NO caemos a MJPEG (fotos) antes de darle tiempo real al
      // flujo RTSP→go2rtc, que es el vivo fluido que se quiere. El póster (snapshot)
      // se muestra mientras tanto, así nunca queda negro.
      //
      // En el HERO (priority) NUNCA degradamos a MJPEG: el operador quiere el flujo
      // RTSP fluido en HD, no fotos del servidor de snapshots. Reintentamos el
      // directo por go2rtc indefinidamente (con backoff suave) hasta que arranque.
      if (!priority && !everPlayed && errStreak >= 8 && onDead) { gaveUp = true; onDead(); return }
      retry = setTimeout(arm, priority ? Math.min(1500 + errStreak * 500, 4000) : 2000)
    }
    // Watchdog anti-congelamiento: el fMP4/MSE progresivo puede TRABARSE sin emitir
    // 'error' ni 'ended' (currentTime deja de avanzar). Si no avanza ~4.5 s estando
    // en marcha, recargamos el stream. También recorta la latencia acumulada.
    const check = () => {
      if (!el) return
      const now = Date.now()
      if (el.currentTime > lastT + 0.05) { lastT = el.currentTime; lastAdvance = now }
      else if (!el.paused && !el.ended && el.readyState >= 1 && now - lastAdvance > 4500) { arm() }
    }
    el.addEventListener('playing', onPlay); el.addEventListener('loadeddata', onPlay)
    el.addEventListener('loadedmetadata', onMeta)
    el.addEventListener('error', onErr); el.addEventListener('ended', onErr)
    arm()
    wd = setInterval(check, 1500)
    return () => {
      clearTimeout(retry); clearInterval(wd)
      el.removeEventListener('playing', onPlay); el.removeEventListener('loadeddata', onPlay)
      el.removeEventListener('loadedmetadata', onMeta); el.removeEventListener('error', onErr); el.removeEventListener('ended', onErr)
      try { el.src = ''; el.removeAttribute('src'); el.load && el.load() } catch { /* noop */ }
    }
  }, [streamName])
  const [snapT, setSnapT] = useState(0)
  useEffect(() => {
    if (state === 'playing' || !deviceId) return
    setSnapT(Date.now())
    const id = setInterval(() => setSnapT(Date.now()), POSTER_REFRESH_MS)
    return () => clearInterval(id)
  }, [state, deviceId])
  const playing = state === 'playing'
  return (
    <div className={`go2view${playing ? ' go2view--playing' : ''}`}>
      {/* El póster (snapshot) aparece YA y avisa con onPoster → quien consume quita
          su skeleton al instante, sin esperar a que conecte el vivo (que carga por
          detrás). El aspecto del bloque lo maneja el contenedor (16:9 fijo). */}
      {!playing && deviceId && (
        <img className="go2view__snap" alt="" src={`/api/camera/${deviceId}/snapshot${snapT ? `?t=${snapT}` : ''}`}
             onLoad={() => onPoster && onPoster()} />
      )}
      <video ref={elRef} className="go2view__video" autoPlay muted playsInline />
      {rules && rules.length > 0 && <AnalyticsOverlay rules={rules} space={space} highlightId={highlightId} />}
      <DecodeBadge videoRef={elRef} active={playing} />
      {!playing && (
        <div className={`go2view__badge${state === 'error' ? ' is-err' : ''}`}>
          {state === 'error' ? 'reintentando…' : <><Spinner size={12} /> conectando vivo…</>}
        </div>
      )}
    </div>
  )
}

// Detecta si el <video> se está decodificando por GPU (hardware) o CPU (software),
// vía MediaCapabilities: powerEfficient ⇒ hardware. Se muestra un badge por canal.
async function probeDecodeMode(w, h) {
  try {
    if (!navigator.mediaCapabilities || !navigator.mediaCapabilities.decodingInfo) return null
    const info = await navigator.mediaCapabilities.decodingInfo({
      type: 'file',
      video: { contentType: 'video/mp4; codecs="avc1.640028"', width: Math.max(320, w || 1280), height: Math.max(180, h || 720), bitrate: 2500000, framerate: 25 },
    })
    return info && info.powerEfficient ? 'gpu' : 'cpu'
  } catch { return null }
}
function DecodeBadge({ videoRef, active }) {
  const [mode, setMode] = useState(null)
  useEffect(() => {
    if (!active) { setMode(null); return }
    const el = videoRef && videoRef.current
    if (!el) return
    let alive = true
    const run = () => probeDecodeMode(el.videoWidth, el.videoHeight).then((m) => { if (alive) setMode(m) })
    if (el.videoWidth) run()
    const on = () => run()
    el.addEventListener('loadedmetadata', on)
    return () => { alive = false; el.removeEventListener('loadedmetadata', on) }
  }, [active, videoRef])
  if (!mode) return null
  return (
    <span className={`decbadge decbadge--${mode}`} title={mode === 'gpu' ? 'Decodificación por hardware (GPU)' : 'Decodificación por software (CPU)'}>
      {mode === 'gpu'
        ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><rect x="5" y="5" width="14" height="14" rx="2"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/><rect x="9" y="9" width="6" height="6" rx="1"/></svg>
        : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 4v16M15 4v16M4 9h16M4 15h16"/></svg>}
      {mode === 'gpu' ? 'GPU' : 'CPU'}
    </span>
  )
}

// Pausa el decode del <video> cuando el tile NO es visible (fuera de pantalla o pestaña
// en segundo plano) — igual que "Detener la transmisión cuando la ventana no es visible"
// de HikCentral. Baja muchísimo el uso de GPU/CPU con muchas cámaras. Al volver a ser
// visible reanuda EN VIVO (salta al borde del buffer, no reproduce lo viejo).
function useVisibilityPause(ref) {
  useEffect(() => {
    const el = ref && ref.current
    if (!el) return
    let visible = !document.hidden, onscreen = true
    const apply = () => {
      try {
        if (visible && onscreen) {
          try { if (el.buffered && el.buffered.length) el.currentTime = el.buffered.end(el.buffered.length - 1) } catch { /* noop */ }
          if (el.paused) el.play().catch(() => {})
        } else if (!el.paused) { el.pause() }
      } catch { /* noop */ }
    }
    const onVis = () => { visible = !document.hidden; apply() }
    document.addEventListener('visibilitychange', onVis)
    let io = null
    try { io = new IntersectionObserver((es) => { onscreen = !!(es[0] && es[0].isIntersecting); apply() }, { threshold: 0.05 }); io.observe(el) } catch { /* sin IO */ }
    return () => { document.removeEventListener('visibilitychange', onVis); if (io) try { io.disconnect() } catch { /* noop */ } }
  }, [ref])
}

// Vivo por HLS H264 transcodificado (modo 'hls'; útil cuando se apague H.264+).
function HlsVideoLive({ deviceId, rules, space, highlightId, onAspect, onPoster = null, quality = 'sub' }) {
  const videoRef = useRef(null)
  useVisibilityPause(videoRef)
  const { phase } = useLiveHlsOn(videoRef, deviceId, quality, (w, h) => { if (onAspect && w && h) onAspect(`${w} / ${h}`) })
  const playing = phase === 'playing'
  const [snapT, setSnapT] = useState(0)
  useEffect(() => {
    if (playing || !deviceId) return
    setSnapT(Date.now())
    const id = setInterval(() => setSnapT(Date.now()), POSTER_REFRESH_MS)
    return () => clearInterval(id)
  }, [playing, deviceId])
  if (!deviceId) return null
  return (
    <div className={`go2view${playing ? ' go2view--playing' : ''}`}>
      {!playing && (
        <img className="go2view__snap" alt="" src={`/api/camera/${deviceId}/snapshot${snapT ? `?t=${snapT}` : ''}`}
             onLoad={(e) => { const n = e.currentTarget; if (onAspect && n.naturalWidth && n.naturalHeight) onAspect(`${n.naturalWidth} / ${n.naturalHeight}`); if (onPoster) onPoster() }} />
      )}
      <video ref={videoRef} className="go2view__video" muted autoPlay playsInline />
      {rules && rules.length > 0 && <AnalyticsOverlay rules={rules} space={space} highlightId={highlightId} />}
      <DecodeBadge videoRef={videoRef} active={playing} />
      {!playing && (
        <div className={`go2view__badge${phase === 'error' ? ' is-err' : ''}`}>
          {phase === 'error' ? 'NEAR-LIVE' : <><Spinner size={12} /> conectando vivo…</>}
        </div>
      )}
    </div>
  )
}

function MjpegLive({ deviceId, rules, space, highlightId, onAspect, onPoster = null, quality = 'sub' }) {
  const [state, setState] = useState('connecting') // connecting | playing | error
  const [streamKey, setStreamKey] = useState(0)
  const [snapT, setSnapT] = useState(0)

  useEffect(() => { setState('connecting'); setStreamKey(Date.now()) }, [deviceId, quality])

  // Póster snapshot instantáneo mientras el primer frame MJPEG decodifica.
  useEffect(() => {
    if (state === 'playing' || !deviceId) return
    setSnapT(Date.now())
    const id = setInterval(() => setSnapT(Date.now()), POSTER_REFRESH_MS)
    return () => clearInterval(id)
  }, [state, deviceId])

  if (!deviceId) return null
  const playing = state === 'playing'
  return (
    <div className={`go2view${playing ? ' go2view--playing' : ''}`}>
      {!playing && (
        <img className="go2view__snap" alt="" src={`/api/camera/${deviceId}/snapshot${snapT ? `?t=${snapT}` : ''}`}
             onLoad={(e) => { const n = e.currentTarget; if (onAspect && n.naturalWidth && n.naturalHeight) onAspect(`${n.naturalWidth} / ${n.naturalHeight}`); if (onPoster) onPoster() }} />
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
    setState('connecting')
    const url = `/go2rtc/api/stream.mp4?src=${encodeURIComponent(src)}`
    let retry
    const arm = () => { try { el.src = url; el.load && el.load(); const p = el.play && el.play(); if (p && p.catch) p.catch(() => {}) } catch { /* noop */ } }
    const onMeta = () => { if (onAspect && el.videoWidth && el.videoHeight) onAspect(`${el.videoWidth} / ${el.videoHeight}`) }
    const onPlay = () => { setState('playing'); onMeta() }
    const onErr = () => { setState((s) => (s === 'playing' ? s : 'error')); clearTimeout(retry); retry = setTimeout(arm, 2500) }
    el.addEventListener('playing', onPlay); el.addEventListener('loadeddata', onPlay)
    el.addEventListener('loadedmetadata', onMeta)
    el.addEventListener('error', onErr); el.addEventListener('ended', onErr)
    arm()
    return () => {
      clearTimeout(retry)
      el.removeEventListener('playing', onPlay); el.removeEventListener('loadeddata', onPlay)
      el.removeEventListener('loadedmetadata', onMeta); el.removeEventListener('error', onErr); el.removeEventListener('ended', onErr)
      try { el.src = ''; el.removeAttribute('src'); el.load && el.load() } catch { /* noop */ }
    }
  }, [src])
  const playing = state === 'playing'
  return (
    <div className={`go2view${playing ? ' go2view--playing' : ''}`}>
      <video ref={elRef} className="go2view__video" autoPlay muted playsInline />
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
// El tope es CONFIGURABLE (Admin · Video → liveConcurrency): así el sistema escala
// a NVRs con más capacidad de conexiones RTSP sin recompilar. Al subir el tope se
// DRENA la cola (arrancan de inmediato los que esperaban), para no dejar tiles
// esperando cuando hay margen.
export let MAX_LIVE = 8
let liveActive = 0
const liveQueue = []
// Reporta la cantidad de flujos en vivo activos al cliente de escritorio (para su HUD
// de rendimiento). Best-effort: si no es escritorio, no hace nada.
function reportLive() {
  try { if (typeof window !== 'undefined' && window.eventosDesktop && window.eventosDesktop.reportLive) window.eventosDesktop.reportLive(liveActive, MAX_LIVE) } catch { /* noop */ }
}
export function setMaxLive(n) {
  const v = Math.min(64, Math.max(1, Math.floor(n) || 8))
  if (v === MAX_LIVE) return
  MAX_LIVE = v
  while (liveActive < MAX_LIVE && liveQueue.length) { liveActive++; const next = liveQueue.shift(); next() }
  reportLive()
}
function acquireLive() {
  if (liveActive < MAX_LIVE) { liveActive++; reportLive(); return Promise.resolve() }
  return new Promise((resolve) => liveQueue.push(resolve))
}
function releaseLive() {
  const next = liveQueue.shift()
  if (next) next()
  else liveActive = Math.max(0, liveActive - 1)
  reportLive()
}

// ── Override GLOBAL del cliente de escritorio (Configuración → Video y rendimiento) ──
// Cada puesto tunea su rendimiento: calidad de la grilla y tope de vivos, sin tocar el
// server. Se aplica una sola vez al cargar, si la app de escritorio inyectó preferencias.
let _clientQuality = null // null=auto (usa lo pedido) | 'sub' | 'main'
export function effQuality(requested, priority = false) {
  if (priority) return requested || 'main'   // hero / vista deliberada: respeta lo pedido
  if (_clientQuality === 'sub') return 'sub'
  if (_clientQuality === 'main') return 'main'
  return requested || 'sub'
}
;(function applyClientVideoPrefs() {
  try {
    const p = (typeof window !== 'undefined' && window.eventosDesktop && window.eventosDesktop.videoPrefs) || null
    if (!p) return
    if (p.quality === 'sub' || p.quality === 'main') _clientQuality = p.quality
    if (Number(p.maxLive) > 0) setMaxLive(Number(p.maxLive))
  } catch { /* noop */ }
})()

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

// Registro de refrescos por deviceId → permite forzar un re-sync desde cualquier
// parte (botón «Sincronizar») sin cambiar la firma del hook.
const anaRefreshers = new Map() // deviceId → Set<fn>
export function refreshCameraAnalytics(deviceId) {
  const set = anaRefreshers.get(deviceId)
  if (set) set.forEach((fn) => fn())
}

// Carga las analíticas dibujadas de una cámara (por id de dispositivo).
export function useCameraAnalytics(deviceId, enabled = true) {
  const [ana, setAna] = useState(null)
  const [tick, setTick] = useState(0)
  // Registrar/desregistrar el refresco global para este deviceId.
  useEffect(() => {
    if (!deviceId) return
    const bump = () => setTick((t) => t + 1)
    let set = anaRefreshers.get(deviceId)
    if (!set) { set = new Set(); anaRefreshers.set(deviceId, set) }
    set.add(bump)
    return () => { set.delete(bump); if (!set.size) anaRefreshers.delete(deviceId) }
  }, [deviceId])
  useEffect(() => {
    if (!enabled || !deviceId) { setAna(null); return }
    let alive = true
    // tick>0 = sync manual → pide fresco (ignora la caché del server).
    fetch(`/api/camera/${deviceId}/analytics${tick ? '?fresh=1' : ''}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive) setAna(d) })
      .catch(() => {})
    return () => { alive = false }
  }, [deviceId, enabled, tick])
  return ana
}

// ¿Es un id de dispositivo real (no una fuente sintética del evento)?
export function isRealDeviceId(id) { return typeof id === 'string' && id.length > 0 && !id.startsWith('__') }

export const ANA_LABEL = { line: 'Cruce de línea', field: 'Intrusión', entrance: 'Entrada a zona', exiting: 'Salida de zona', baggage: 'Objeto abandonado', takenaway: 'Objeto retirado' }

// Dibuja las reglas sobre el video. Hikvision: origen abajo-izquierda → invierte Y.
// `hidden` (Set de tipos) permite ocultar analíticas concretas desde la leyenda.
export function AnalyticsOverlay({ rules, space = 1000, highlightId = null, hidden = null }) {
  const shown = (rules || []).filter((r) => !(hidden && hidden.has(r.type)))
  if (!shown.length) return null
  const fy = (y) => space - y
  return (
    <svg className="anov" viewBox={`0 0 ${space} ${space}`} preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <marker id="anar" markerWidth="9" markerHeight="9" refX="6.5" refY="3" orient="auto">
          <path d="M0,0 L7,3 L0,6 Z" fill="#f5b945" />
        </marker>
      </defs>
      {shown.map((r, i) => {
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

// Etiqueta con el NOMBRE de cada analítica dibujada, posada SOBRE el dibujo
// (centro de la zona / punto medio de la línea). Capa HTML — texto siempre nítido
// (sin la distorsión del SVG estirado). Se posiciona en % → alinea con el overlay.
export function AnalyticsLabels({ rules, space = 1000 }) {
  if (!rules || !rules.length) return null
  const fy = (y) => space - y
  return (
    <div className="analabels" aria-hidden="true">
      {rules.map((r, i) => {
        const pts = r.points || []
        if (!pts.length) return null
        const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length
        const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length
        return (
          <span key={i} className={`analabel analabel--${r.type}`}
                style={{ left: `${(cx / space) * 100}%`, top: `${(fy(cy) / space) * 100}%` }}>
            {ANA_LABEL[r.type] || r.type}
          </span>
        )
      })}
    </div>
  )
}

// `onToggle` (opcional) convierte las píldoras en botones para mostrar/ocultar cada
// analítica; `hidden` es el Set de tipos ocultos. Sin `onToggle` es solo lectura.
export function AnalyticsLegend({ rules, hidden = null, onToggle = null }) {
  const counts = rules.reduce((a, r) => { a[r.type] = (a[r.type] || 0) + 1; return a }, {})
  return (
    <div className="ana-legend">
      {Object.entries(counts).map(([t, n]) => {
        const off = !!(hidden && hidden.has(t))
        const label = `${ANA_LABEL[t] || t} · ${n}`
        return onToggle
          ? <button key={t} type="button" className={`ana-pill ana-pill--${t} ana-pill--btn${off ? ' is-off' : ''}`}
                    onClick={() => onToggle(t)} aria-pressed={!off} title={off ? 'Mostrar' : 'Ocultar'}>{label}</button>
          : <span key={t} className={`ana-pill ana-pill--${t}`}>{label}</span>
      })}
    </div>
  )
}
