import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Hls from 'hls.js'
import { Icon, Spinner, Skeleton } from '../ui/primitives.jsx'
import { apiFetch } from '../lib/eventsApi.js'

// Reproductor de grabación del NVR estilo "Time Machine" (UniFi Protect), con una
// LÍNEA DE TIEMPO VERTICAL tipo scrubber a la derecha: EN VIVO arriba, el pasado
// hacia abajo, eventos como ÍCONOS sobre la línea. Se navega con la RUEDA del mouse
// (adelanta/retrocede), ARRASTRANDO la línea, o con los botones ±. Zoom con −/+.
// El VIDEO va por HLS transcodificado en el server (mismo pipeline que el vivo; NO
// go2rtc → sin el "Empty src" de MSE con el H264 corrupto del NVR): al soltar el
// playhead el server arranca una sesión HLS desde ese instante.

const MIN = 60000
const hikTime = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
const fmtClock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
const fmtHM = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const fmtDate = (ms) => new Date(ms).toLocaleDateString([], { weekday: 'short', day: '2-digit', month: 'short' })
const toLocalInput = (ms) => { const d = new Date(ms); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}` }
const fromLocalInput = (s) => { const t = new Date(s).getTime(); return Number.isFinite(t) ? t : null }

// Glifo por tipo de evento / objetivo IA → marca de la línea de tiempo.
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

export default function NvrPlayback({ event, onClose, startOffsetMs = 15000 }) {
  const railRef = useRef(null)
  const draggingRef = useRef(false)

  const eventT = new Date(event.deviceTs || event.ts).getTime()
  // Cuánto ANTES del instante ancla arranca la reproducción. Por defecto 15 s (para
  // ver el preámbulo de una alarma); en "instant replay" se pasa 30/60 s.
  const preMs = Math.max(0, Number(startOffsetMs) || 0)
  // Ventana de búsqueda REACTIVA: duración (zoom) + fecha ancla. Por defecto ~1h con
  // el evento cerca del inicio-superior (poco después / mucho antes).
  const [spanMin, setSpanMin] = useState(60)
  const [anchorMs, setAnchorMs] = useState(eventT)
  const range = useMemo(() => {
    const span = spanMin * MIN
    return { start: Math.round(anchorMs - span * 0.83), end: Math.round(anchorMs + span * 0.17) }
  }, [anchorMs, spanMin])
  const span = range.end - range.start
  // Presets de ZOOM (ventana visible). Menos minutos = más detalle (zoom in).
  const ZOOM = [3, 5, 10, 15, 30, 60, 180, 360, 720, 1440]
  const zoomIdx = Math.max(0, ZOOM.indexOf(spanMin) < 0 ? 5 : ZOOM.indexOf(spanMin))
  const spanLabel = spanMin >= 1440 ? `${Math.round(spanMin / 1440)} d` : spanMin >= 60 ? `${Math.round(spanMin / 60)} h` : `${spanMin} min`
  const setZoom = (idx) => { const i = Math.max(0, Math.min(ZOOM.length - 1, idx)); setSpanMin(ZOOM[i]) }

  const deviceId = (event && event.source && event.source.deviceId) || null
  const synthetic = String((event && event.id) || '').startsWith('live_')

  const videoRef = useRef(null)
  const hlsRef = useRef(null)
  const sidRef = useRef(null)
  const segStartRef = useRef(null)
  const seekOffRef = useRef(0)
  const seekedRef = useRef(false)
  const winRef = useRef(null) // {s,e} ventana UTC ya producida → seek LOCAL instantáneo
  const [hlsUrl, setHlsUrl] = useState(null)
  const [seekKey, setSeekKey] = useState(0)
  const [playFrom, setPlayFrom] = useState(eventT - preMs)
  const [playhead, setPlayhead] = useState(eventT - preMs)
  const [dragTime, setDragTime] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [paused, setPaused] = useState(false)
  const [evMarks, setEvMarks] = useState([])
  const [flt, setFlt] = useState(false) // popover "ir a fecha" abierto

  // Marcas de hora ADAPTATIVAS según el ancho de la ventana (~6-8 marcas legibles).
  const NICE_STEPS = [10e3, 30e3, 60e3, 2 * 60e3, 5 * 60e3, 10 * 60e3, 15 * 60e3, 30 * 60e3, 3600e3, 2 * 3600e3, 3 * 3600e3, 6 * 3600e3, 12 * 3600e3, 24 * 3600e3]
  const tickStep = useMemo(() => NICE_STEPS.find((s) => span / s <= 8) || NICE_STEPS[NICE_STEPS.length - 1], [span]) // eslint-disable-line react-hooks/exhaustive-deps
  const ticks = useMemo(() => {
    const out = []
    for (let t = Math.ceil(range.start / tickStep) * tickStep; t <= range.end; t += tickStep) out.push(t)
    return out
  }, [range.start, range.end, tickStep])
  const tickLabel = (ms) => (span > 18 * 3600e3 ? new Date(ms).toLocaleString([], { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : fmtHM(ms))

  // Eventos de ESTA cámara dentro de la ventana → íconos en la línea de tiempo.
  useEffect(() => {
    if (!deviceId) return
    let alive = true
    apiFetch('/api/events?limit=1000').then((r) => (r.ok ? r.json() : null)).then((d) => {
      if (!alive || !d || !d.events) return
      const marks = d.events
        .filter((e) => e.source && e.source.deviceId === deviceId)
        .map((e) => ({ id: e.id, t: new Date(e.deviceTs || e.ts).getTime(), priority: e.priority ?? 5, type: e.type, target: e.target ?? null }))
        .filter((m) => m.t >= range.start && m.t <= range.end)
        .sort((a, b) => b.t - a.t)
      setEvMarks(marks)
    }).catch(() => {})
    return () => { alive = false }
  }, [deviceId, range.start, range.end])

  // Pide al server una sesión HLS de grabación desde el instante t.
  const seek = useCallback((t) => {
    const clamped = Math.max(range.start, Math.min(range.end - 5000, t))
    // SEEK LOCAL instantáneo: si el instante cae dentro de lo YA producido por la
    // sesión actual, sólo movemos el <video> (exacto, sin re-pedir al NVR) → scrub
    // fino buttery. currentTime = (instante − inicio de sesión).
    const w = winRef.current, vEl = videoRef.current
    if (w && vEl && segStartRef.current != null && clamped >= w.s + 200 && clamped <= w.e - 800) {
      try { vEl.currentTime = Math.max(0, (clamped - segStartRef.current) / 1000); const pp = vEl.play && vEl.play(); if (pp && pp.catch) pp.catch(() => {}) } catch { /* noop */ }
      setPlayFrom(clamped); setPlayhead(clamped); setError(false)
      return
    }
    const prev = sidRef.current
    if (prev) { sidRef.current = null; fetch(`/api/playback/${prev}`, { method: 'DELETE' }).catch(() => {}) }
    setPlayFrom(clamped); setPlayhead(clamped); setError(false); setLoading(true)
    fetch('/api/playback-hls', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId, start: hikTime(clamped), end: hikTime(range.end) }),
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('playback'))))
      .then((d) => {
        sidRef.current = d.id
        segStartRef.current = (typeof d.segStartMs === 'number') ? d.segStartMs : null
        seekOffRef.current = Math.max(0, Number(d.seekOffsetSec) || 0)
        seekedRef.current = false
        winRef.current = (typeof d.segStartMs === 'number' && typeof d.coverEndMs === 'number') ? { s: d.segStartMs, e: d.coverEndMs } : null
        setHlsUrl(d.url); setSeekKey((k) => k + 1)
      })
      .catch(() => { setError(true); setLoading(false) })
  }, [deviceId, range.start, range.end])

  useEffect(() => {
    seek(eventT - 15000)
    return () => { if (sidRef.current) fetch(`/api/playback/${sidRef.current}`, { method: 'DELETE' }).catch(() => {}) }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Sólo los SALTOS de ancla (fecha / evento / vivo) re-piden video. El ZOOM
  // (spanMin) NO re-pide: sólo cambia la escala visual de la línea de tiempo.
  const firstWinRef = useRef(true)
  useEffect(() => {
    if (firstWinRef.current) { firstWinRef.current = false; return }
    seek(anchorMs - Math.min(15000, spanMin * MIN * 0.1))
  }, [anchorMs]) // eslint-disable-line react-hooks/exhaustive-deps

  // Adjunta hls.js al <video> cuando cambia la URL de la sesión (cada seek).
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
        hls.on(Hls.Events.FRAG_BUFFERED, () => {
          if (cancelled) return
          setLoading(false)
          if (!seekedRef.current && seekOffRef.current > 0.5 && v.duration && seekOffRef.current < v.duration - 0.5) {
            try { v.currentTime = seekOffRef.current } catch { /* noop */ }
            seekedRef.current = true
          }
        })
        hls.on(Hls.Events.ERROR, (_e, d) => {
          if (!d.fatal) return
          if (d.type === Hls.ErrorTypes.NETWORK_ERROR) { try { hls.startLoad() } catch { /* noop */ } }
          else if (d.type === Hls.ErrorTypes.MEDIA_ERROR) { try { hls.recoverMediaError() } catch { /* noop */ } }
          else setError(true)
        })
      } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
        v.src = hlsUrl; v.play().catch(() => {}); v.addEventListener('loadeddata', () => {
          if (cancelled) return
          setLoading(false)
          if (!seekedRef.current && seekOffRef.current > 0.5 && v.duration && seekOffRef.current < v.duration - 0.5) {
            try { v.currentTime = seekOffRef.current } catch { /* noop */ }
            seekedRef.current = true
          }
        }, { once: true })
      } else setError(true)
    }

    // Sondeo RÁPIDO del m3u8: apenas aparece un .ts, adjuntamos hls.js. Paso corto
    // (250 ms) para que la grabación arranque cuanto antes tras el seek.
    const waitReady = async () => {
      for (let i = 0; i < 110 && !cancelled; i++) {
        try {
          const txt = await fetch(`${hlsUrl}?_=${Date.now()}`, { cache: 'no-store' }).then((r) => (r.ok ? r.text() : ''))
          if (/\.ts(\?|\s|$)/m.test(txt)) { attach(); return }
        } catch { /* reintenta */ }
        await new Promise((r) => setTimeout(r, 250))
      }
      if (!cancelled) attach()
    }
    waitReady()

    return () => { cancelled = true; if (hlsRef.current) { try { hlsRef.current.destroy() } catch { /* noop */ } hlsRef.current = null } }
  }, [hlsUrl, seekKey])

  useEffect(() => {
    const id = setInterval(() => { if (sidRef.current) fetch(`/api/playback/${sidRef.current}/keepalive`, { method: 'POST' }).catch(() => {}) }, 120000)
    return () => clearInterval(id)
  }, [])

  // El playhead avanza ~tiempo real mientras reproduce.
  useEffect(() => {
    if (!hlsUrl) return
    const id = setInterval(() => {
      if (draggingRef.current) return
      const v = videoRef.current
      const base = segStartRef.current != null ? segStartRef.current : playFrom
      const ct = v && v.currentTime > 0 ? v.currentTime * 1000 : null
      setPlayhead(Math.min(range.end, ct != null ? base + ct : playFrom))
    }, 400)
    return () => clearInterval(id)
  }, [hlsUrl, seekKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // Estado play/pausa sincronizado con el <video>.
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const on = () => setPaused(false), off = () => setPaused(true)
    v.addEventListener('play', on); v.addEventListener('pause', off)
    return () => { v.removeEventListener('play', on); v.removeEventListener('pause', off) }
  }, [])

  // ── Scrub vertical: tiempo ↔ posición (arriba = más nuevo = range.end) ─────────
  const topFrac = (t) => (range.end - t) / span // 0 arriba (nuevo) … 1 abajo (viejo)
  const topPct = (t) => `${Math.max(0, Math.min(100, topFrac(t) * 100))}%`
  const timeFromY = (clientY) => {
    const el = railRef.current
    if (!el) return playhead
    const r = el.getBoundingClientRect()
    const frac = Math.max(0, Math.min(1, (clientY - r.top) / r.height))
    return range.end - frac * span // arriba→end, abajo→start
  }

  const seekDebRef = useRef(null)
  const clampT = (t) => Math.max(range.start, Math.min(range.end - 5000, t))

  // RUEDA DEL MOUSE = ZOOM (acercar / alejar) sobre la línea de tiempo. Arriba =
  // acercar (más detalle), abajo = alejar (más rango). El ARRASTRE mueve el cabezal
  // y lo suelta donde se quiera. Así se busca cómodo: zoom con rueda, ir con arrastre.
  useEffect(() => {
    const el = railRef.current
    if (!el) return
    const onWheel = (e) => {
      e.preventDefault()
      setSpanMin((cur) => {
        const i = ZOOM.indexOf(cur); const ci = i < 0 ? 5 : i
        const ni = e.deltaY > 0 ? Math.min(ZOOM.length - 1, ci + 1) : Math.max(0, ci - 1)
        return ZOOM[ni]
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Scrub LOCAL en vivo mientras se arrastra: si el instante ya está producido,
  // el <video> sigue el dedo al instante (sin re-pedir). Al soltar, seek definitivo.
  const localScrub = (t) => {
    const w = winRef.current, v = videoRef.current
    if (w && v && segStartRef.current != null && t >= w.s + 200 && t <= w.e - 800) {
      try { v.currentTime = Math.max(0, (t - segStartRef.current) / 1000) } catch { /* noop */ }
    }
  }
  const onDown = (e) => { draggingRef.current = true; const t = timeFromY(e.clientY); setDragTime(t); setPlayhead(t); localScrub(t); e.currentTarget.setPointerCapture?.(e.pointerId) }
  const onMove = (e) => { if (!draggingRef.current) return; const t = timeFromY(e.clientY); setDragTime(t); setPlayhead(t); localScrub(t) }
  const onUp = (e) => { if (!draggingRef.current) return; draggingRef.current = false; const t = timeFromY(e.clientY); setDragTime(null); if (seekDebRef.current) clearTimeout(seekDebRef.current); seek(t) }

  // Transporte: retroceder / adelantar N seg, play-pausa, ir a EN VIVO.
  const nudge = (sec) => { const t = clampT((dragTime ?? playhead) + sec * 1000); setPlayhead(t); if (seekDebRef.current) clearTimeout(seekDebRef.current); seek(t) }
  const togglePlay = () => { const v = videoRef.current; if (!v) return; if (v.paused) v.play().catch(() => {}); else v.pause() }
  const goLive = () => { setAnchorMs(Date.now()) }

  const cur = dragTime ?? playhead
  const isLiveWin = Math.abs(range.end - Date.now()) < 90 * 1000

  return (
    <div className="nvrpb nvrpb--vt">
      {/* El VIDEO llena el escenario; la línea de tiempo vertical flota a la derecha. */}
      <video ref={videoRef} className="nvrpb__vid" muted autoPlay playsInline />
      {loading && !error && (
        <div className="nvrpb__skel"><Skeleton className="nvrpb__skelfill" w="100%" h="100%" /></div>
      )}
      {error && (
        <div className="nvrpb__overlay nvrpb__overlay--err">
          <Icon name="alert" size={24} /><span>No se pudo abrir la grabación.</span>
        </div>
      )}

      {/* Transporte centrado abajo; el reloj va SOLO abajo-derecha (misma altura). */}
      <span className="nvrpb__clockcorner">
        <strong className="tnum">{fmtClock(cur)}</strong>
        <em className="nvrpb__date">{fmtDate(cur)}</em>
      </span>
      <div className="nvrpb__hud">
        <div className="nvrpb__transport">
          <button type="button" className="nvrpb__tb nvrpb__tb--back" onClick={() => nudge(-30)} title="Retroceder 30 s" aria-label="-30s"><span className="tnum">30</span><Icon name="chevron" size={15} /></button>
          <button type="button" className="nvrpb__tb nvrpb__tb--back" onClick={() => nudge(-10)} title="Retroceder 10 s" aria-label="-10s"><Icon name="chevron" size={18} /></button>
          <button type="button" className="nvrpb__pp" onClick={togglePlay} title={paused ? 'Reproducir' : 'Pausar'} aria-label="Play/Pausa"><Icon name={paused ? 'play' : 'pause'} size={18} /></button>
          <button type="button" className="nvrpb__tb" onClick={() => nudge(10)} title="Adelantar 10 s" aria-label="+10s"><Icon name="chevron" size={18} /></button>
          <button type="button" className="nvrpb__tb" onClick={() => nudge(30)} title="Adelantar 30 s" aria-label="+30s"><Icon name="chevron" size={15} /><span className="tnum">30</span></button>
        </div>
      </div>

      {/* ── LÍNEA DE TIEMPO VERTICAL (scrubber) ─────────────────────────────── */}
      <div className="nvrvt">
        <div className="nvrvt__head">
          <span className="nvrvt__title">Últimas <b>{spanLabel}</b></span>
          <span className="nvrvt__count"><Icon name="bolt" size={11} /> {evMarks.length}</span>
        </div>
        <div className="nvrvt__zoom">
          <button type="button" onClick={() => setZoom(zoomIdx + 1)} title="Alejar (más tiempo)" aria-label="Alejar"><Icon name="minus" size={15} /></button>
          <input type="range" min="0" max={ZOOM.length - 1} value={zoomIdx}
            onChange={(e) => setZoom(ZOOM.length - 1 - Number(e.target.value))} aria-label="Zoom de la línea de tiempo" />
          <button type="button" onClick={() => setZoom(zoomIdx - 1)} title="Acercar (más detalle)" aria-label="Acercar"><Icon name="plus" size={15} /></button>
        </div>

        <div ref={railRef} className="nvrvt__rail" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
          {/* EN VIVO / borde superior de la ventana → clic va a "ahora". */}
          <button type="button" className={`nvrvt__live${isLiveWin ? ' is-live' : ''}`} onClick={goLive} title="Ir a EN VIVO (ahora)">
            <span className="nvrvt__livedot" /> {isLiveWin ? 'EN VIVO' : 'IR A VIVO'}
          </button>

          <div className="nvrvt__line" />
          <span className="nvrvt__played" style={{ height: topPct(cur) }} />

          {ticks.map((t) => (
            <span className="nvrvt__tick" key={t} style={{ top: topPct(t) }}>
              <b className="tnum">{tickLabel(t)}</b><i />
            </span>
          ))}

          {evMarks.map((m) => { const g = evGlyph(m); const active = Math.abs(cur - m.t) < 30000; return (
            <button type="button" key={m.id} className={`nvrvt__ev tone-${g.tone}${active ? ' is-active' : ''}`}
              style={{ top: topPct(m.t) }} title={evTip(m)}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); if (seekDebRef.current) clearTimeout(seekDebRef.current); setDragTime(null); seek(m.t) }}>
              <Icon name={g.icon} size={13} />
            </button>
          ) })}

          {!synthetic && eventT >= range.start && eventT <= range.end && (
            <span className="nvrvt__evmark" style={{ top: topPct(eventT) }} title="Evento de la alarma" />
          )}

          {/* Cabezal de reproducción: línea + burbuja con la hora. */}
          <div className="nvrvt__playhead" style={{ top: topPct(cur) }}>
            <span className="nvrvt__phline" />
            <span className="nvrvt__phbubble tnum">{fmtClock(cur)}</span>
          </div>
        </div>

        {/* Ir a fecha/hora concreta. */}
        <div className="nvrvt__foot">
          <button type="button" className={`nvrvt__go${flt ? ' is-open' : ''}`} onClick={() => setFlt((f) => !f)} title="Ir a fecha / hora">
            <Icon name="clock" size={14} /> Ir a fecha
          </button>
          {flt && (
            <div className="nvrvt__pop">
              <input type="datetime-local" autoFocus value={toLocalInput(anchorMs)}
                onChange={(e) => { const ms = fromLocalInput(e.target.value); if (ms) setAnchorMs(ms) }} />
              <div className="nvrvt__poprow">
                <button type="button" onClick={() => { setAnchorMs(eventT); setFlt(false) }}><Icon name="bolt" size={12} /> Evento</button>
                <button type="button" onClick={() => { setAnchorMs(Date.now()); setFlt(false) }}><Icon name="clock" size={12} /> Ahora</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
