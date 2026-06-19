import { useEffect, useRef } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

// Mapa de ubicación del sitio (Leaflet + OpenStreetMap / Esri satélite).
// - Capas conmutables: Calle (OSM) y Satélite (Esri World Imagery).
// - Marcador de la ubicación del cliente (divIcon, sin imágenes externas).
// - Clic en el mapa fija/mueve la ubicación → onPick(lat, lng).
// Pensado para vivir dentro de un modal: hace invalidateSize tras montar.

const DEFAULT_CENTER = [-33.4489, -70.6693] // Santiago, CL (fallback)
const PIN_HTML =
  '<span class="sitemap-pin"><span class="sitemap-pin__dot"></span></span>'

export default function SiteMap({ lat, lng, onPick, height = 300 }) {
  const elRef = useRef(null)
  const mapRef = useRef(null)
  const markerRef = useRef(null)
  const onPickRef = useRef(onPick)
  onPickRef.current = onPick

  // Init una sola vez.
  useEffect(() => {
    if (mapRef.current || !elRef.current) return
    const hasCoords = Number.isFinite(lat) && Number.isFinite(lng)
    const center = hasCoords ? [lat, lng] : DEFAULT_CENTER

    const street = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© OpenStreetMap',
    })
    const satellite = L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      { maxZoom: 19, attribution: 'Esri, Maxar, Earthstar Geographics' },
    )

    const map = L.map(elRef.current, {
      center,
      zoom: hasCoords ? 16 : 12,
      layers: [street],
      zoomControl: true,
      attributionControl: true,
    })
    L.control.layers(
      { Calle: street, Satélite: satellite },
      {},
      { position: 'topright', collapsed: false },
    ).addTo(map)

    const icon = L.divIcon({
      className: 'sitemap-divicon',
      html: PIN_HTML,
      iconSize: [28, 28],
      iconAnchor: [14, 26],
    })
    if (hasCoords) {
      markerRef.current = L.marker([lat, lng], { icon, draggable: true }).addTo(map)
      markerRef.current.on('dragend', (e) => {
        const { lat: la, lng: ln } = e.target.getLatLng()
        onPickRef.current?.(round(la), round(ln))
      })
    }

    map.on('click', (e) => {
      const { lat: la, lng: ln } = e.latlng
      onPickRef.current?.(round(la), round(ln))
    })

    mapRef.current = map
    // El modal anima/redimensiona: recalcular el tamaño cuando ya está visible.
    setTimeout(() => map.invalidateSize(), 60)
    setTimeout(() => map.invalidateSize(), 280)

    return () => {
      map.remove()
      mapRef.current = null
      markerRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Sincroniza el marcador cuando cambian las coords desde fuera (clic / drag / inputs).
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const hasCoords = Number.isFinite(lat) && Number.isFinite(lng)
    if (!hasCoords) {
      if (markerRef.current) { map.removeLayer(markerRef.current); markerRef.current = null }
      return
    }
    const icon = L.divIcon({
      className: 'sitemap-divicon', html: PIN_HTML, iconSize: [28, 28], iconAnchor: [14, 26],
    })
    if (!markerRef.current) {
      markerRef.current = L.marker([lat, lng], { icon, draggable: true }).addTo(map)
      markerRef.current.on('dragend', (e) => {
        const { lat: la, lng: ln } = e.target.getLatLng()
        onPickRef.current?.(round(la), round(ln))
      })
    } else {
      markerRef.current.setLatLng([lat, lng])
    }
  }, [lat, lng])

  return <div ref={elRef} className="sitemap" style={{ height }} aria-label="Mapa de ubicación" />
}

function round(n) {
  return Math.round(n * 1e6) / 1e6
}
