import { useEffect, useRef } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { priorityClass } from '../lib/format.js'

// Mapa operativo (GIS) de la consola: todos los sitios con coordenadas como
// marcadores. Cada marcador toma el color/criticidad del PEOR evento activo de
// ese sitio y PARPADEA si hay un crítico sin asignar; muestra el nº de eventos
// activos. Clic en un sitio con evento → abre el popup del evento.

export default function OperativeMap({ sites, events, onOpenEvent }) {
  const elRef = useRef(null)
  const mapRef = useRef(null)
  const markersRef = useRef(new Map()) // siteId → L.marker
  const ctx = useRef({ sites, events, onOpenEvent })
  ctx.current = { sites, events, onOpenEvent }

  // Init una vez.
  useEffect(() => {
    if (mapRef.current || !elRef.current) return
    const street = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' })
    const sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Esri, Maxar' })
    const map = L.map(elRef.current, { center: [-33.45, -70.66], zoom: 5, layers: [street] })
    L.control.layers({ Calle: street, Satélite: sat }, {}, { position: 'topright', collapsed: false }).addTo(map)
    mapRef.current = map
    setTimeout(() => map.invalidateSize(), 60)
    setTimeout(() => map.invalidateSize(), 320)
    setTimeout(() => map.invalidateSize(), 800)
    // Recalcula el tamaño cuando el contenedor cambia (pantalla completa, switch de vista).
    let ro
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => { try { map.invalidateSize() } catch { /* noop */ } })
      ro.observe(elRef.current)
    }
    return () => { if (ro) ro.disconnect(); map.remove(); mapRef.current = null; markersRef.current.clear() }
  }, [])

  // Sincroniza marcadores cuando cambian sitios o eventos.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const geo = (ctx.current.sites || []).filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lng))
    const byName = new Map(geo.map((s) => [(s.name || '').toLowerCase(), s]))

    // Sitio → {worst, attn, count, event}
    const siteEvt = new Map()
    for (const e of ctx.current.events || []) {
      if (e.status === 'resolved' || e.status === 'escalated') continue
      const site = byName.get(((e.source && e.source.site) || '').toLowerCase())
      if (!site) continue
      const cur = siteEvt.get(site.id) || { count: 0, worst: 99, attn: false, event: null }
      cur.count++
      const p = e.priority ?? 5
      if (p < cur.worst) { cur.worst = p; cur.event = e }
      if (p <= 1 && e.status === 'new' && !e.assignedTo) cur.attn = true
      siteEvt.set(site.id, cur)
    }

    const seen = new Set()
    const bounds = []
    for (const s of geo) {
      seen.add(s.id)
      bounds.push([s.lat, s.lng])
      const info = siteEvt.get(s.id)
      const pc = info ? priorityClass(info.worst) : null
      const html =
        `<span class="opmap-pin ${info ? 'opmap-pin--evt' : ''} ${info && info.attn ? 'opmap-pin--attn' : ''}"` +
        `${pc ? ` style="--c:var(--${pc})"` : ''}>${info ? `<span class="opmap-pin__n">${info.count}</span>` : ''}</span>`
      const icon = L.divIcon({ className: 'opmap-divicon', html, iconSize: [26, 26], iconAnchor: [13, 13] })
      let m = markersRef.current.get(s.id)
      if (!m) {
        m = L.marker([s.lat, s.lng], { icon }).addTo(map)
        markersRef.current.set(s.id, m)
      } else {
        m.setIcon(icon)
        m.setLatLng([s.lat, s.lng])
      }
      m.unbindTooltip()
      m.bindTooltip(info ? `${s.name} · ${info.count} activo(s)` : (s.name || 'Sitio'), { direction: 'top', offset: [0, -12] })
      m.off('click')
      m.on('click', () => {
        const inf = siteEvt.get(s.id)
        if (inf && inf.event && ctx.current.onOpenEvent) ctx.current.onOpenEvent(inf.event)
      })
    }
    for (const [id, m] of markersRef.current) {
      if (!seen.has(id)) { map.removeLayer(m); markersRef.current.delete(id) }
    }
    if (bounds.length && !map._opmapFitted) {
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 })
      map._opmapFitted = true
    }
  }, [sites, events])

  return <div ref={elRef} className="opmap" aria-label="Mapa operativo" />
}
