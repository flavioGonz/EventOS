// AccessReadBadge — badge animado y efímero sobre el VIVO cuando alguien entra por
// un portero (tag/PIN/rostro/QR válido) de ESE cliente/sitio. Push por socket
// (`access:read`), overlay DOM: NO toca el `<video>` ni el pipeline de video.
// Autocontenido: se suscribe al pub/sub del socket y se filtra por sitio.
import { useEffect, useRef, useState } from 'react'
import { Icon } from '../ui/primitives.jsx'
import { onAccessRead } from '../lib/socket.js'

const METHOD = {
  card: { icon: 'tag',   label: 'Tarjeta' },
  pin:  { icon: 'hash',  label: 'PIN' },
  face: { icon: 'user',  label: 'Rostro' },
  qr:   { icon: 'hash',  label: 'QR' },
}
const TTL = 6500        // ms visible cada badge
const MAX_SHOWN = 4     // tope simultáneo en pantalla

// Hook: entrega los accesos recientes (que matchean el sitio) para mostrar como badge.
export function useAccessReads(siteName) {
  const [shown, setShown] = useState([])
  const siteRef = useRef(siteName)
  siteRef.current = siteName

  useEffect(() => {
    const off = onAccessRead((ar) => {
      const sn = String(siteRef.current || '').trim().toLowerCase()
      // Si hay sitio de contexto, solo mostramos accesos de ESE sitio. Sin contexto
      // (p.ej. wall sin foco), mostramos todos.
      if (sn && String(ar.site || '').trim().toLowerCase() !== sn) return
      setShown((prev) => {
        if (prev.some((x) => x.id === ar.id)) return prev
        return [{ id: ar.id, ar, at: Date.now() }, ...prev].slice(0, MAX_SHOWN)
      })
    })
    return off
  }, [])

  // Expiración.
  useEffect(() => {
    if (!shown.length) return
    const t = setInterval(() => {
      setShown((prev) => {
        const next = prev.filter((x) => Date.now() - x.at < TTL)
        return next.length === prev.length ? prev : next
      })
    }, 400)
    return () => clearInterval(t)
  }, [shown.length])

  return shown
}

export default function AccessReadBadge({ siteName, className = '' }) {
  const shown = useAccessReads(siteName)
  if (!shown.length) return null
  return (
    <div className={`accbadges ${className}`}>
      {shown.map(({ id, ar }) => {
        const m = METHOD[ar.method] || { icon: 'shieldcheck', label: 'Acceso' }
        return (
          <div key={id} className={`accbadge accbadge--${ar.method || 'card'}`} role="status">
            <span className="accbadge__ic"><Icon name={m.icon} size={16} /></span>
            <span className="accbadge__body">
              <b className="accbadge__name">{ar.personName || 'Acceso concedido'}</b>
              <span className="accbadge__meta">{m.label} · {ar.deviceName || 'Portero'}</span>
            </span>
            <span className="accbadge__pulse" aria-hidden="true" />
          </div>
        )
      })}
    </div>
  )
}
