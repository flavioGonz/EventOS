// VendorLogo — identidad de marca por fabricante (wordmark en color de marca).
// No reproduce el logotipo registrado pixel a pixel: usa el nombre en el
// color de cada marca, que es lo que necesita el operador para reconocer el
// equipo de un vistazo, sin problemas de copyright.
import { Icon } from './icons.jsx'

// Color de marca + texto del wordmark por id de fabricante.
const BRANDS = {
  Hikvision: { c: '#E2231A', txt: 'HIKVISION', w: 700 },
  Dahua:     { c: '#E1251B', txt: 'dahua', w: 700, lower: true },
  Tiandy:    { c: '#0F5FB5', txt: 'TIANDY', w: 750 },
  Akuvox:    { c: '#0B57A4', txt: 'AKUVOX', w: 700 },
  Uniview:   { c: '#F07F1A', txt: 'UNV', w: 800 },
  ONVIF:     { c: '#00A0AF', txt: 'ONVIF', w: 700 },
}

export function VendorLogo({ id, size = 18, className }) {
  const b = BRANDS[id]
  if (!b) {
    // Sin marca conocida: icono genérico (SIP/parlante, ONVIF genérico, etc.).
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
