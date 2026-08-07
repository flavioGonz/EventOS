// VendorLogo — identidad de marca por fabricante.
// No reproduce el logotipo registrado pixel a pixel: usa el color de marca +
// un monograma/wordmark propio, que es lo que necesita el operador para
// reconocer el equipo de un vistazo, sin problemas de copyright.
import { Icon } from './icons.jsx'

// Por marca: color primario (c), color secundario del degradé (c2),
// texto del wordmark (txt), monograma para el tile (mono) y peso tipográfico.
const BRANDS = {
  Hikvision: { c: '#E2231A', c2: '#B01610', txt: 'HIKVISION', mono: 'H', w: 750 },
  Dahua:     { c: '#E1251B', c2: '#A81812', txt: 'dahua', mono: 'D', w: 750, lower: true },
  Tiandy:    { c: '#0F5FB5', c2: '#0A3F7C', txt: 'TIANDY', mono: 'T', w: 760 },
  Akuvox:    { c: '#0B57A4', c2: '#083E76', txt: 'AKUVOX', mono: 'A', w: 740 },
  Uniview:   { c: '#F07F1A', c2: '#C25F09', txt: 'UNV', mono: 'UNV', w: 820 },
  Siera:     { c: '#12A594', c2: '#0B6E63', txt: 'SIERA', mono: 'S', w: 760 },
  Intelbras: { c: '#00A651', c2: '#00713A', txt: 'intelbras', mono: 'i', w: 750, lower: true },
  ONVIF:     { c: '#00A0AF', c2: '#007883', txt: 'ONVIF', mono: 'O', w: 720 },
}

// Tile SVG premium: cuadrado redondeado con degradé de marca + monograma.
// Es una representación propia (no el logotipo oficial), pensada para la UI.
function BrandTile({ b, id, size }) {
  const gid = `bg-${id}`
  const font = b.mono.length > 1 ? size * 0.34 : size * 0.5
  return (
    <svg className="vtile" width={size} height={size} viewBox="0 0 48 48" role="img" aria-label={id}>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={b.c} />
          <stop offset="1" stopColor={b.c2 || b.c} />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="46" height="46" rx="12" fill={`url(#${gid})`} />
      <rect x="1" y="1" width="46" height="46" rx="12" fill="none" stroke="rgba(255,255,255,.16)" />
      <text x="24" y="25" textAnchor="middle" dominantBaseline="central"
        fill="#fff" fontFamily="Inter, system-ui, sans-serif" fontWeight="800"
        fontSize={font} letterSpacing={b.mono.length > 1 ? '.5' : '0'}>{b.mono}</text>
    </svg>
  )
}

export function VendorLogo({ id, size = 18, variant = 'wordmark', className }) {
  const b = BRANDS[id]

  // Variante "tile": logo grande de marca (para la grilla de selección).
  if (variant === 'tile') {
    if (!b) return (
      <span className={`vtile vtile--fallback ${className || ''}`} style={{ width: size, height: size }}>
        <Icon name="device" size={Math.round(size * 0.5)} />
      </span>
    )
    return <span className={`vtilewrap ${className || ''}`}><BrandTile b={b} id={id} size={size} /></span>
  }

  // Variante por defecto: wordmark en color de marca (inline, contextos chicos).
  if (!b) {
    return <span className={`vlogo vlogo--icon ${className || ''}`} style={{ height: size }}><Icon name="device" size={size} /></span>
  }
  return (
    <span className={`vlogo ${className || ''}`} style={{ '--vc': b.c, fontSize: Math.round(size * 0.86) }} title={id}>
      <span className="vlogo__dot" />
      <span className="vlogo__txt" style={{ fontWeight: b.w, letterSpacing: b.lower ? '0' : '.04em' }}>{b.txt}</span>
    </span>
  )
}

export const VENDOR_BRANDS = BRANDS
export default VendorLogo
