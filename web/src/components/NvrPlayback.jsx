import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Hls from 'hls.js'
import { Icon, Spinner } from '../ui/primitives.jsx'

// Reproductor de grabación del NVR estilo "Time Machine" (UniFi Protect):
// una línea de tiempo arrastrable sobre una ventana de ~1h alrededor del evento.
// El VIDEO va por HLS transcodificado en el server (mismo pipeline que el vivo;
// NO go2rtc → sin el "Empty src" de MSE con el H264 corrupto del NVR): al soltar
// el playhead, el server arranca una sesión HLS desde ese instante. El marcador
// rojo es el momento del evento.

const MIN = 60000
const hikTime = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
const fmtClock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
const fmtHM = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const fmtDate = (ms) => new Date(ms).toLocaleDateString([], { weekday: 'short', day: '2-digit', month: 'short' })

// Glifo por tipo de evento / objetivo IA → marca del timeline y filmstrip.
const EV_GLYPH = {
  human:           { icon: 'user',      label: 'Humano',     tone: 'hum' },
  vehicle:         { icon: 'car',       label: 'Vehículo',   tone: 'veh' },
  line_crossing:   { icon: 'linecross', label: 'Cruce',      tone: 'cross' },
  intrusion:       { icon: 'zone',      label: 'Intrusión',  tone: 'zone' },
  region_entrance: { icon: 'zone',      label: 'Entrada',    tone: 'zone' },
  region_exit:     { icon: 'zone',      label: 'Salida',     tone: 'zone' },
  face:            { icon: 'face',      label: 'Rostro',     tone: 'face' },
  lpr:             { icon: 'plate',     label: 'LPR',        tone: 'lpr' },
  motion:          { icon: 'bolt',      label: 'Movimiento', tone: 'mov' },
}
const evGlyph = (m) => (m.target === 'human' && EV_GLYPH.human) || (m.target === 'vehicle' && EV_GLYPH.vehicle) || EV_GLYPH[m.type] || { icon: 'bolt', label: m.type || 'Evento', tone: 'mov' }
const evTip = (m) => { const ty = (EV_GLYPH[m.type] && EV_GLYPH[m.type].label) || m.type || 'evento'; const tg = m.target === 'human' ? ' · Humano' : m.target === 'vehicle' ? ' · Vehículo' : ''; return ty + tg + ' · ' + fmtClock(m.t) }

export default function NvrPlayback({ event, onClose }) {
  const trackRef = useRef(null)
  const draggingRef = useRef(false)

  const eventT = new Date(event.deviceTs || event.ts).getTime()
  const range = useRef({ start: eventT - 50 * MIN, end: eventT + 10 * MIN }).current
  const span = range.end - range.start
  const deviceId = (event && event.source && event.source.deviceId) || null
  const synthetic = String((event && event.id) || '').startsWith('live_') // grabación abierta desde el Muro (sin alarma)

  const videoRef = useRef(null)
  const hlsRef = useRef(null)
  const sidRef = useRef(null)
  const [hlsUrl, setHlsUrl] = useState(null)
  const [seekKey, setSeekKey] = useState(0)
  const [playFrom, setPlayFrom] = useState(eventT - 15000)
  const [playhead, setPlayhead] = useState(eventT - 15000)
  const [dragTime, setDragTime] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [evMarks, setEvMarks] = useState([])

  // Marcas de hora cada 10 min dentro de la ventana (~1h).
  const ticks = useMemo(() => {
    const step = 10 * MIN
    const out = []
    for (let t = Math.ceil(range.start / step) * step; t <= range.end; t += step) out.push(t)
    return out
  }, [range.start, range.end])

  // Eventos de ESTA cámara dentro de la ventana → marcas en la línea de tiempo.
  useEffect(() => {
    if (!deviceId) return
    let alive = true
    fetch('/api/events?limit=1000').then((r) => (r.ok ? r.json() : null)).then((d) => {
      if (!alive || !d || !d.events) return
      const marks = d.events
        .filter((e) => e.source && e.source.deviceId === deviceId)
        .map((e) => ({
          id: e.id, t: new Date(e.deviceTs || e.ts).getTime(), priority: e.priority ?? 5, type: e.type,
          target: e.target ?? null,
          img: (e.media && (e.media.evidenceUrl || e.media.snapshotUrl)) || null,
        }))
        .filter((m) => m.t >= range.start && m.t <= range.end)
        .sort((a, b) => a.t - b.t)
      setEvMarks(marks)
    }).catch(() => {})
    return () => { alive = false }
  }, [deviceId, range.start, range.end])

  // Pide al server una sesión HLS de grabación desde el instante t.
  const seek = useCallback((t) => {
    const clamped = Math.max(range.start, Math.min(range.end - 5000, t))
    // Cierra la sesión ffmpeg anterior: evita acumular procesos y, sobre todo,
    // que el desalojo por límite de sesiones mate vivos de operadores en curso.
    const prev = sidRef.current
    if (prev) { sidRef.current = null; fetch(`/api/playback/${prev}`, { method: 'DELETE' }).catch(() => {}) }
    setPlayFrom(clamped); setPlayhead(clamped); setError(false); setLoading(true)
    fetch('/api/playback-hls', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId, start: hikTime(clamped), end: hikTime(range.end) }),
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('playback'))))
      .then((d) => { sidRef.current = d.id; setHlsUrl(d.url); setSeekKey((k) => k + 1) })
      .catch(() => { setError(true); setLoading(false) })
  }, [deviceId, range.start, range.end])

  useEffect(() => {
    seek(eventT - 15000)
    return () => { if (sidRef.current) fetch(`/api/playback/${sidRef.current}`, { method: 'DELETE' }).catch(() => {}) }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Adjunta hls.js al <video> cuando cambia la URL de la sesión (cada seek).
  // CLAVE: ffmpeg tarda ~3-6 s en escribir el primer segmento; mientras tanto el
  // server sirve un m3u8 "warming" vacío que hace que hls.js se atasque. Por eso
  // ESPERAMOS (sondeando el m3u8) a que aparezca un segmento real antes de
  // adjuntar hls.js. Así nunca ve una playlist vacía.
  useEffect(() => {
    if (!hlsUrl) return
    const v = videoRef.current
    if (!v) return
    let cancelled = false
    if (hlsRef.current) { try { hlsRef.current.destroy() } catch { /* noop */ } hlsRef.current = null }

    const attach = () => {
      if (cancelled) return
      if (Hls.isSupported()) {
        const hls = new Hls({ liveSyncDurationCount: 3, manifestLoadingMaxRetry: 6, levelLoadingMaxRetry: 6, fragLoadingMaxRetry: 10, lowLatencyMode: false })
        hlsRef.current = hls
        hls.loadSource(hlsUrl); hls.attachMedia(v)
        hls.on(Hls.Events.MANIFEST_PARSED, () => v.play().catch(() => {}))
        hls.on(Hls.Events.FRAG_BUFFERED, () => { if (!cancelled) setLoading(false) })
        hls.on(Hls.Events.ERROR, (_e, d) => {
          if (!d.fatal) return
          if (d.type === Hls.ErrorTypes.NETWORK_ERROR) { try { hls.startLoad() } catch { /* noop */ } }
          else if (d.type === Hls.ErrorTypes.MEDIA_ERROR) { try { hls.recoverMediaError() } catch { /* noop */ } }
          else setError(true)
        })
      } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
        v.src = hlsUrl; v.play().catch(() => {}); v.addEventListener('loadeddata', () => { if (!cancelled) setLoading(false) }, { once: true })
      } else setError(true)
    }

    // Sondeo del m3u8 hasta que liste un segmento (.ts); máx ~28 s.
    const waitReady = async () => {
      for (let i = 0; i < 40 && !cancelled; i++) {
        try {
          const txt = await fetch(`${hlsUrl}?_=${Date.now()}`, { cache: 'no-store' }).then((r) => (r.ok ? r.text() : ''))
          if (/\.ts(\?|\s|$)/m.test(txt)) { attach(); return }
        } catch { /* reintenta */ }
        await new Promise((r) => setTimeout(r, 700))
      }
      if (!cancelled) attach() // último intento aunque no se haya detectado segmento
    }
    waitReady()

    return () => { cancelled = true; if (hlsRef.current) { try { hlsRef.current.destroy() } catch { /* noop */ } hlsRef.current = null } }
  }, [hlsUrl, seekKey])

  // Mantiene viva la sesión HLS (heartbeat) mientras el modal está abierto.
  useEffect(() => {
    const id = setInterval(() => { if (sidRef.current) fetch(`/api/playback/${sidRef.current}/keepalive`, { method: 'POST' }).catch(() => {}) }, 120000)
    return () => clearInterval(id)
  }, [])

  // El playhead avanza ~tiempo real mientras reproduce.
  useEffect(() => {
    if (!hlsUrl) return
    const p0 = playFrom; const t0 = Date.now()
    const id = setInterval(() => {
      if (draggingRef.current) return
      const v = videoRef.current
      // Sigue el tiempo REAL del video (currentTime); cae a reloj de pared si aún no arrancó.
      const elapsed = v && v.currentTime > 0 ? v.currentTime * 1000 : (Date.now() - t0)
      setPlayhead(Math.min(range.end, p0 + elapsed))
    }, 400)
    return () => clearInterval(id)
  }, [hlsUrl, seekKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const timeFromX = (clientX) => {
    const el = trackRef.current
    if (!el) return playhead
    const r = el.getBoundingClientRect()
    const frac = Math.max(0, Math.min(1, (clientX - r.left) / r.width))
    return range.start + frac * span
  }
  const onDown = (e) => { draggingRef.current = true; const t = timeFromX(e.clientX); setDragTime(t); setPlayhead(t); e.currentTarget.setPointerCapture?.(e.pointerId) }
  const onMove = (e) => { if (!draggingRef.current) return; const t = timeFromX(e.clientX); setDragTime(t); setPlayhead(t) }
  const onUp = (e) => { if (!draggingRef.current) return; draggingRef.current = false; const t = timeFromX(e.clientX); setDragTime(null); seek(t) }

  const pct = (t) => `${((t - range.start) / span) * 100}%`

  return (
    <div className="nvrpb">
      {/* El VIDEO llena el escenario; los controles flotan como overlay (sin marcos). */}
      <video ref={videoRef} className="nvrpb__vid" muted autoPlay playsInline />
      {loading && !error && (
        <div className="nvrpb__overlay"><Spinner size={20} /><span>cargando grabación…</span></div>
      )}
      {error && (
        <div className="nvrpb__overlay nvrpb__overlay--err">
          <Icon name="alert" size={24} /><span>No se pudo abrir la grabación.</span>
        </div>
      )}

      <div className="nvrpb__controls">
        <div className="nvrpb__row">
          <span className="nvrpb__clockbig">
            <Icon name="play" size={15} />
            <strong className="tnum">{fmtClock(dragTime ?? playhead)}</strong>
            <em className="nvrpb__date">{fmtDate(dragTime ?? playhead)}</em>
          </span>
          <span className="nvrpb__sp" />
          {evMarks.length > 0 && <span className="nvrpb__evcount"><Icon name="bolt" size={12} /> {evMarks.length} evento{evMarks.length === 1 ? '' : 's'} en esta hora</span>}
          {deviceId && (
            <button type="button" className="nvrpb__back" title="Descargar un clip MP4 de 1 min desde este instante"
              onClick={() => {
                const a = document.createElement('a')
                a.href = `/api/playback-clip?deviceId=${encodeURIComponent(deviceId)}&start=${hikTime(dragTime ?? playhead)}&dur=60`
                a.download = ''
                document.body.appendChild(a); a.click(); a.remove()
              }}><Icon name="download" size={13} /> Descargar clip</button>
          )}
          <button type="button" className="nvrpb__back" onClick={onClose}><Icon name="video" size={13} /> Volver al vivo</button>
        </div>

        {evMarks.length > 0 && (
          <div className="nvrfilm">
            {evMarks.map((m) => {
              const active = Math.abs((dragTime ?? playhead) - m.t) < 30000
              const p = m.priority <= 1 ? 1 : m.priority <= 2 ? 2 : 3
              const g = evGlyph(m)
              return (
                <button type="button" key={m.id} className={`nvrfilm__thumb p${p}${active ? ' is-active' : ''}`}
                  onClick={() => seek(m.t)} title={evTip(m)}>
                  <span className="nvrfilm__img">
                    {m.img && <img src={m.img} alt="" loading="lazy" onError={(e) => { e.currentTarget.style.display = 'none' }} />}
                    <span className={`nvrfilm__badge tone-${g.tone}`}><Icon name={g.icon} size={13} /></span>
                  </span>
                  <span className="nvrfilm__meta">
                    <span className={`nvrfilm__type tone-${g.tone}`}><Icon name={g.icon} size={11} /> {g.label}</span>
                    <span className="nvrfilm__time tnum">{fmtClock(m.t)}</span>
                  </span>
                </button>
              )
            })}
          </div>
        )}

        <div className="nvrtl2">
          <div ref={trackRef} className="nvrtl2__track" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}>
            <span className="nvrtl2__played" style={{ width: pct(playhead) }} />
            {ticks.map((t) => (
              <span className="nvrtl2__tick" key={t} style={{ left: pct(t) }}>
                <i /><b className="tnum">{fmtHM(t)}</b>
              </span>
            ))}
            {evMarks.map((m) => { const g = evGlyph(m); return (
              <button type="button" key={m.id} className={`nvrtl2__ev tone-${g.tone}`}
                style={{ left: pct(m.t) }} title={evTip(m)}
                onClick={(e) => { e.stopPropagation(); seek(m.t) }}><Icon name={g.icon} size={11} /></button>
            ) })}
            {!synthetic && <span className="nvrtl2__event" style={{ left: pct(eventT) }} title="Evento actual" />}
            <span className="nvrtl2__head" style={{ left: pct(playhead) }} />
            {dragTime != null && <span className="nvrtl2__bubble tnum" style={{ left: pct(dragTime) }}>{fmtClock(dragTime)}</span>}
          </div>
          <p className="nvrtl2__hint">Arrastra la línea para revisar · los puntos son eventos · el rojo es la alarma actual</p>
        </div>
      </div>
    </div>
  )
}
