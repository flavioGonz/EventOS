// FlowGraph — stream-graph de área apilada hecho a mano en SVG (sin librerías).
// Estética "Caudal Forense": ribbons de vidrio translúcidas con línea especular,
// graticule forense tenue, eje de tiempo y tooltip de desglose por bucket.
// CONTRACT-V3 §4. Solo tokens del sistema de diseño.
import { useEffect, useId as reactUseId, useMemo, useRef, useState } from 'react'
import { EmptyState } from '../ui/primitives.jsx'

// useId envuelto: React 18 lo trae; saneamos los ':' para usarlo en ids de <defs>.
function useId() { return reactUseId().replace(/:/g, '') }

/* ---------- Paleta ---------- */
// Cuando groupBy=priority usamos --p1..--p5 (temperatura cromática del póster).
// Para el resto, una rampa derivada de --accent + temperatura, tasteful y estable.
const PRIORITY_KEYS = ['1', '2', '3', '4', '5']
const FALLBACK_RAMP = [
  'var(--p1)', 'var(--p2)', 'var(--p3)', 'var(--accent-2)',
  'var(--p4)', 'var(--accent)', 'var(--p5)',
  'color-mix(in srgb, var(--p1) 60%, var(--accent))',
  'color-mix(in srgb, var(--p4) 70%, var(--accent-2))',
  'color-mix(in srgb, var(--p2) 55%, var(--accent))',
]
export function seriesColor(series, index, groupBy) {
  if (groupBy === 'priority' && PRIORITY_KEYS.includes(String(series.key))) {
    return `var(--p${series.key})`
  }
  return FALLBACK_RAMP[index % FALLBACK_RAMP.length]
}

/* ---------- Formato de tiempo del eje según bucket ---------- */
const pad = (n) => String(n).padStart(2, '0')
function fmtTick(iso, bucket) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  if (bucket === 'minute') return `${pad(d.getHours())}:${pad(d.getMinutes())}`
  if (bucket === 'hour')   return `${pad(d.getHours())}:00`
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`            // day
}
function fmtFull(iso, bucket) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const day = `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`
  if (bucket === 'day') return day
  return `${day} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/* ---------- Curva suave (Catmull-Rom → Bézier cúbica) ---------- */
// Suaviza una polilínea respetando los puntos; los ribbons "respiran" sin overshoot brusco.
function smoothPath(points, smoothing = 0.5) {
  if (points.length === 0) return ''
  if (points.length === 1) return `M ${points[0][0]} ${points[0][1]}`
  let d = `M ${points[0][0]} ${points[0][1]}`
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] || points[i]
    const p1 = points[i]
    const p2 = points[i + 1]
    const p3 = points[i + 2] || p2
    const c1x = p1[0] + ((p2[0] - p0[0]) / 6) * smoothing
    const c1y = p1[1] + ((p2[1] - p0[1]) / 6) * smoothing
    const c2x = p2[0] - ((p3[0] - p1[0]) / 6) * smoothing
    const c2y = p2[1] - ((p3[1] - p1[1]) / 6) * smoothing
    d += ` C ${c1x} ${c1y} ${c2x} ${c2y} ${p2[0]} ${p2[1]}`
  }
  return d
}

/* ---------- Hook de ancho responsive ---------- */
function useWidth() {
  const ref = useRef(null)
  const [w, setW] = useState(880)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const cw = entries[0]?.contentRect?.width
      if (cw && cw > 0) setW(Math.round(cw))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, w]
}

const M = { top: 16, right: 16, bottom: 30, left: 40 }
const HEIGHT = 360

export default function FlowGraph({ data, bucket = 'hour', groupBy = 'priority', highlight = null, onHover }) {
  const [wrapRef, width] = useWidth()
  const [hover, setHover] = useState(null) // { i, x }
  const uid = useId()

  const buckets = data?.buckets || []
  const series = data?.series || []
  const n = buckets.length

  const innerW = Math.max(120, width - M.left - M.right)
  const innerH = HEIGHT - M.top - M.bottom

  // --- Apilado: para cada bucket sumamos las series en orden; calculamos el máx total. ---
  const { bands, maxTotal, xOf } = useMemo(() => {
    const x = (i) => (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW)
    let max = 0
    for (let i = 0; i < n; i++) {
      let s = 0
      for (const ser of series) s += (ser.values?.[i] || 0)
      if (s > max) max = s
    }
    max = max || 1
    const y = (v) => innerH - (v / max) * innerH
    // Apilado acumulado por bucket → cada banda guarda top/bottom polilíneas.
    const cum = new Array(n).fill(0)
    const out = series.map((ser, si) => {
      const top = []
      const bot = []
      for (let i = 0; i < n; i++) {
        const base = cum[i]
        const v = ser.values?.[i] || 0
        bot.push([x(i), y(base)])
        top.push([x(i), y(base + v)])
        cum[i] = base + v
      }
      return { ser, si, top, bot }
    })
    return { bands: out, maxTotal: max, xOf: x }
  }, [series, n, innerW, innerH])

  // Ticks del eje X: no saturar; ~ cada k buckets.
  const ticks = useMemo(() => {
    if (n === 0) return []
    const target = Math.max(2, Math.min(9, Math.floor(innerW / 90)))
    const step = Math.max(1, Math.ceil(n / target))
    const out = []
    for (let i = 0; i < n; i += step) out.push(i)
    if (out[out.length - 1] !== n - 1) out.push(n - 1)
    return out
  }, [n, innerW])

  // Gridlines Y forenses (4 divisiones).
  const yGrid = useMemo(() => {
    const lines = []
    for (let g = 0; g <= 4; g++) {
      const v = (maxTotal / 4) * g
      lines.push({ y: innerH - (v / maxTotal) * innerH, v: Math.round(v) })
    }
    return lines
  }, [maxTotal, innerH])

  const totalAll = data?.total ?? 0
  if (!n || !series.length || totalAll === 0) {
    return (
      <div ref={wrapRef} className="flow-graph flow-graph--empty">
        <EmptyState icon="layers" title="Sin flujo en el rango">
          Ajusta el rango temporal o los filtros para ver el caudal de eventos.
        </EmptyState>
      </div>
    )
  }

  const handleMove = (e) => {
    const svg = e.currentTarget
    const rect = svg.getBoundingClientRect()
    const px = ((e.clientX - rect.left) / rect.width) * width - M.left
    if (n === 1) { setHover({ i: 0, x: xOf(0) }); onHover?.(0); return }
    const i = Math.max(0, Math.min(n - 1, Math.round((px / innerW) * (n - 1))))
    setHover({ i, x: xOf(i) })
    onHover?.(i)
  }
  const handleLeave = () => { setHover(null); onHover?.(null) }

  const hi = highlight
  const someHi = hi != null

  return (
    <div ref={wrapRef} className="flow-graph">
      <svg
        viewBox={`0 0 ${width} ${HEIGHT}`}
        width="100%" height={HEIGHT}
        preserveAspectRatio="none"
        className="flow-svg"
        onMouseMove={handleMove}
        onMouseLeave={handleLeave}
        role="img"
        aria-label="Stream-graph de flujo de eventos en el tiempo"
      >
        <defs>
          {/* Brillo de vidrio: degradado vertical translúcido por banda. */}
          {bands.map(({ si, ser }) => {
            const c = seriesColor(ser, si, groupBy)
            return (
              <linearGradient key={si} id={`${uid}-g${si}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%"   stopColor={c} stopOpacity="0.62" />
                <stop offset="55%"  stopColor={c} stopOpacity="0.34" />
                <stop offset="100%" stopColor={c} stopOpacity="0.16" />
              </linearGradient>
            )
          })}
          {/* Clip de revelado para la entrada ultra-rápida (wipe izquierda→derecha). */}
          <clipPath id={`${uid}-reveal`}>
            <rect className="flow-reveal" x="0" y="0" width={width} height={HEIGHT} />
          </clipPath>
        </defs>

        <g transform={`translate(${M.left},${M.top})`}>
          {/* Graticule forense */}
          <g className="flow-grid">
            {yGrid.map((g, k) => (
              <g key={k}>
                <line x1="0" y1={g.y} x2={innerW} y2={g.y} className="flow-grid__line" />
                <text x={-8} y={g.y} className="flow-grid__lbl" textAnchor="end" dominantBaseline="middle">{g.v}</text>
              </g>
            ))}
            {ticks.map((i) => (
              <line key={`vx${i}`} x1={xOf(i)} y1="0" x2={xOf(i)} y2={innerH} className="flow-grid__vline" />
            ))}
          </g>

          {/* Ribbons de vidrio (apiladas) */}
          <g clipPath={`url(#${uid}-reveal)`}>
            {bands.map(({ ser, si, top, bot }) => {
              const color = seriesColor(ser, si, groupBy)
              // Área cerrada: borde superior suavizado, baja al borde inferior y vuelve suavizado.
              const botRev = smoothPath([...bot].reverse()).replace(/^M/, 'L')
              const area = `${smoothPath(top)} ${botRev} Z`
              const dim = someHi && hi !== si
              return (
                <g key={si} className={`flow-band${dim ? ' is-dim' : ''}${someHi && hi === si ? ' is-hot' : ''}`}>
                  <path d={area} fill={`url(#${uid}-g${si})`} className="flow-band__fill" />
                  {/* línea especular brillante en el borde superior (el "gleam") */}
                  <path d={smoothPath(top)} fill="none" stroke={color} className="flow-band__edge" />
                </g>
              )
            })}
          </g>

          {/* Cursor + puntos en hover */}
          {hover && (
            <g className="flow-cursor" pointerEvents="none">
              <line x1={hover.x} y1="0" x2={hover.x} y2={innerH} className="flow-cursor__line" />
              {bands.map(({ ser, si, top }) => {
                const v = ser.values?.[hover.i] || 0
                if (!v) return null
                return <circle key={si} cx={top[hover.i][0]} cy={top[hover.i][1]} r="3"
                               fill={seriesColor(ser, si, groupBy)} className="flow-cursor__dot" />
              })}
            </g>
          )}

          {/* Eje de tiempo */}
          <g className="flow-axis" transform={`translate(0,${innerH})`}>
            <line x1="0" y1="0" x2={innerW} y2="0" className="flow-axis__base" />
            {ticks.map((i) => (
              <text key={i} x={xOf(i)} y={18} className="flow-axis__tick" textAnchor="middle">
                {fmtTick(buckets[i], bucket)}
              </text>
            ))}
          </g>
        </g>
      </svg>

      {/* Tooltip HTML (posicionado por porcentaje, escala con el SVG estirado) */}
      {hover && (
        <FlowTooltip
          xPct={(M.left + hover.x) / width}
          bucketLabel={fmtFull(buckets[hover.i], bucket)}
          rows={bands
            .map(({ ser, si }) => ({ label: ser.label || ser.key, v: ser.values?.[hover.i] || 0, c: seriesColor(ser, si, groupBy) }))
            .filter((r) => r.v > 0)
            .sort((a, b) => b.v - a.v)}
          total={bands.reduce((s, { ser }) => s + (ser.values?.[hover.i] || 0), 0)}
        />
      )}
    </div>
  )
}

function FlowTooltip({ xPct, bucketLabel, rows, total }) {
  const left = `${(xPct * 100).toFixed(2)}%`
  const flip = xPct > 0.62
  return (
    <div className={`flow-tip glass glass--strong${flip ? ' flow-tip--left' : ''}`} style={{ left }}>
      <div className="flow-tip__head">
        <span className="flow-tip__time tnum">{bucketLabel}</span>
        <span className="flow-tip__total tnum">{total}</span>
      </div>
      <ul className="flow-tip__list">
        {rows.map((r, k) => (
          <li key={k}>
            <span className="flow-tip__sw" style={{ background: r.c }} />
            <span className="flow-tip__lbl">{r.label}</span>
            <span className="flow-tip__v tnum">{r.v}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
