import { useEffect, useMemo, useState } from 'react'
import CameraTile from './CameraTile.jsx'
import { Icon, IconButton, Segmented, Spinner, EmptyState } from '../ui/primitives.jsx'
import { formatTime } from '../lib/format.js'
import { apiFetch } from '../lib/eventsApi.js'

// CameraWall — "Muro de video" del Centro de Verificación en Vivo.
//
// Al abrir, consulta GET /api/cameras?site=<sitio del evento> y arma la lista
// de cámaras del sitio. Identifica la CÁMARA FUENTE (la que disparó el evento):
//   1. por nombre (deviceName/name, sin distinguir mayúsculas)
//   2. por IP
//   3. por canal (channel)
//   4. si nada casa → sintetiza una "fuente" desde el propio evento
//      (nombre = event.source.deviceName, snapshot = event.media.snapshotUrl).
//
// Vistas conmutables: Hero (1) / 2×2 / 3×3. La fuente siempre va primero y
// queda marcada con anillo de acento + tag "EVENTO". Click en un satélite lo
// destaca (swap al hero).

const norm = (v) => (v == null ? '' : String(v).trim().toLowerCase())

function eventSite(event) {
  const s = (event && event.source) || {}
  return s.site || event.site || event.zone || ''
}

// Sintetiza un "tile fuente" desde el propio evento cuando no hay cámara real.
function synthSourceCamera(event) {
  const s = (event && event.source) || {}
  const realId = s.deviceId && /^dev_/.test(String(s.deviceId)) ? s.deviceId : `__event__${event.id}`
  return {
    id: realId,
    name: s.deviceName || s.deviceId || 'Cámara del evento',
    zone: event.zone || s.site || '',
    site: s.site || '',
    ip: s.ip,
    channel: s.channel,
    streamUrl: (event.media && event.media.streamUrl) || null,
    snapshotUrl: (event.media && event.media.snapshotUrl) || null,
    __synthetic: true,
  }
}

// Devuelve el índice de la cámara fuente dentro de `cams`, o -1.
function matchSourceIndex(cams, event) {
  const s = (event && event.source) || {}
  const wantId = s.deviceId
  if (wantId) { const i = cams.findIndex((c) => c.id === wantId); if (i >= 0) return i }
  const wantName = norm(s.deviceName || s.deviceId)
  const wantIp = norm(s.ip)
  const wantCh = s.channel

  if (wantName) {
    const i = cams.findIndex((c) => norm(c.name) === wantName)
    if (i >= 0) return i
  }
  if (wantIp) {
    const i = cams.findIndex((c) => norm(c.ip) === wantIp)
    if (i >= 0) return i
  }
  if (wantCh !== undefined && wantCh !== null && wantCh !== '') {
    const i = cams.findIndex((c) => String(c.channel) === String(wantCh))
    if (i >= 0) return i
  }
  return -1
}

export default function CameraWall({ event }) {
  const [cameras, setCameras] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [view, setView] = useState('hero') // hero | 2x2 | 3x3
  const [spotId, setSpotId] = useState(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [page, setPage] = useState(0)       // página del mosaico (grilla slide)
  // Hero por defecto en MAIN (HD): al abrir el Hero se trae el MAINSTREAM del canal
  // del evento, a plena calidad. El toggle HD/SD permite bajar a sub si se quiere
  // aliviar el NVR. (El mosaico sigue la regla de rendimiento: ≤4 canales → main.)
  const [heroQuality, setHeroQuality] = useState('main')
  // Columnas Interior/Perímetro COLAPSADAS por defecto: al abrir el Hero sólo carga
  // el video grande (cero snapshots de las columnas) → arranque y cambio de cámara
  // lo más rápido posible. El operador despliega una columna como botón cuando la
  // necesita para barrer canales. Se abre de a una (la otra se cierra) para no
  // saturar la red con miniaturas mientras busca.
  const [openCol, setOpenCol] = useState(null) // null | 'interior' | 'perimeter'
  const [recentByCam, setRecentByCam] = useState({}) // camId → nº eventos últimos 15 min (badge de seguimiento)

  const site = eventSite(event)

  // Cargar cámaras del sitio.
  useEffect(() => {
    let alive = true
    setLoading(true)
    setError('')
    const url = `/api/cameras?site=${encodeURIComponent(site || '')}`
    fetch(url, { headers: { Accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data) => {
        if (!alive) return
        setCameras(Array.isArray(data && data.cameras) ? data.cameras : [])
        setLoading(false)
      })
      .catch((e) => {
        if (!alive) return
        setError(e.message || 'No se pudieron cargar las cámaras')
        setCameras([])
        setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [site, event && event.id, reloadKey])

  // Seguimiento visual: nº de eventos por cámara en los últimos 15 min → alimenta el
  // badge de los hotspots posados sobre el video. Sondeo liviano cada 30 s. La
  // asociación evento→cámara sigue la misma precedencia que matchSourceIndex
  // (deviceId → nombre → ip → canal). Esto NO es el overlay de alarmas de la grilla
  // (eso se quitó): es un indicador del seguimiento de escena, sobre los iconos.
  useEffect(() => {
    if (cameras.length === 0) return
    let alive = true
    const byName = new Map(), byIp = new Map(), byCh = new Map()
    for (const c of cameras) {
      if (c.name) byName.set(norm(c.name), c.id)
      if (c.ip) byIp.set(norm(c.ip), c.id)
      if (c.channel != null && c.channel !== '') byCh.set(String(c.channel), c.id)
    }
    const byId = new Set(cameras.map((c) => c.id))
    const load = () => {
      apiFetch('/api/events?limit=200')
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (!alive) return
          const list = Array.isArray(d) ? d : (d && d.events) || []
          const cut = Date.now() - 15 * 60 * 1000
          const counts = {}
          for (const e of list) {
            const t = new Date(e.deviceTs || e.ts).getTime()
            if (!(t >= cut)) continue
            const s = e.source || {}
            let cid = null
            if (s.deviceId && byId.has(s.deviceId)) cid = s.deviceId
            else if (s.deviceName && byName.has(norm(s.deviceName))) cid = byName.get(norm(s.deviceName))
            else if (s.ip && byIp.has(norm(s.ip))) cid = byIp.get(norm(s.ip))
            else if (s.channel != null && byCh.has(String(s.channel))) cid = byCh.get(String(s.channel))
            if (cid) counts[cid] = (counts[cid] || 0) + 1
          }
          setRecentByCam(counts)
        })
        .catch(() => {})
    }
    load()
    const id = setInterval(load, 30000)
    return () => { alive = false; clearInterval(id) }
  }, [cameras])

  // Lista ordenada: fuente primero (real o sintética), luego satélites.
  const { ordered, sourceId } = useMemo(() => {
    const list = cameras.slice()
    const idx = matchSourceIndex(list, event)
    let srcCam
    if (idx >= 0) {
      srcCam = list.splice(idx, 1)[0]
    } else {
      srcCam = synthSourceCamera(event)
    }
    return { ordered: [srcCam, ...list], sourceId: srcCam.id }
  }, [cameras, event])

  // Cámara destacada en el hero (la fuente por defecto).
  const heroId = spotId || sourceId
  const heroCam = ordered.find((c) => c.id === heroId) || ordered[0]

  // Hotspots de seguimiento de la cámara del hero: iconos de cámaras vecinas sobre el
  // video. Clic → esa cámara sube al hero (se encadena el recorrido de la escena). El
  // badge muestra sus eventos de los últimos 15 min. Se configuran en /wall; acá van
  // en solo-lectura para que el operador siga la escena durante la alarma.
  const heroHots = useMemo(() => {
    const links = (heroCam && Array.isArray(heroCam.wallLinks)) ? heroCam.wallLinks : []
    if (!links.length) return null
    return links.map((l) => {
      const tgt = ordered.find((c) => c.id === l.target) || cameras.find((c) => c.id === l.target)
      const nm = (tgt && tgt.name) || l.label || 'cámara'
      const ch = tgt && tgt.channel != null && tgt.channel !== '' ? `#${tgt.channel} ` : ''
      return { id: l.id, x: l.x, y: l.y, target: l.target, label: `${ch}${nm}`, count: recentByCam[l.target] || 0 }
    })
  }, [heroCam, ordered, cameras, recentByCam])

  const p = event && (event.priority ?? 5)
  const evTs = event && event.ts ? formatTime(event.ts) : null
  // Id de la regla/zona que disparó el evento (para resaltarla en el overlay).
  const triggerId = (event && event.raw && (event.raw.regionID || event.raw.RegionID || event.raw.lineID)) || null

  const viewOptions = [
    { value: 'hero', label: 'Hero' },
    { value: '2x2', label: '2×2' },
    { value: '3x3', label: '3×3' },
  ]

  const gridCount = view === '2x2' ? 4 : view === '3x3' ? 9 : 1
  // Regla de rendimiento: hasta 4 canales en vivo → MAINSTREAM (calidad plena);
  // más de 4 → SUBSTREAM (liviano). Hero = 1 canal → main.
  const liveQuality = (view === 'hero' ? 1 : gridCount) <= 4 ? 'main' : 'sub'
  const pageCount = Math.max(1, Math.ceil(ordered.length / gridCount))
  const curPage = Math.min(page, pageCount - 1)
  const gridCams = ordered.slice(curPage * gridCount, curPage * gridCount + gridCount)

  // Columnas del Hero: derecha «Perímetro», izquierda «Interior». Si la cámara no
  // trae etiqueta `area`, se INFIERE del nombre/zona (frente, portón, garaje… →
  // perímetro; ascensor, escalera, pasillo… → interior) para que ambas columnas
  // queden pobladas sin etiquetar a mano. La etiqueta explícita siempre manda.
  const PERIM_RE = /frente|perimetr|exterior|calle|port[oó]n|gara[jg]e|entrada|acceso|fachada|patio|estacion|vereda|reja|jard|azotea|terraza|balcon|balc[oó]n/
  const INTER_RE = /interior|ascensor|escalera|escalad|pasillo|hall|recep|sala|oficina|piso|dep\b|apto|unidad|cocina|ba[nñ]o|lobby|estar/
  const areaOf = (c) => {
    const a = norm(c.area)
    if (a === 'perimeter' || a === 'interior') return a
    const s = `${norm(c.name)} ${norm(c.zone)}`
    if (PERIM_RE.test(s)) return 'perimeter'
    if (INTER_RE.test(s)) return 'interior'
    return 'interior'
  }
  const perimeterCams = ordered.filter((c) => areaOf(c) === 'perimeter')
  const interiorCams = ordered.filter((c) => areaOf(c) !== 'perimeter')

  return (
    <div className="camwall">
      <div className="camwall__bar">
        <span className="camwall__count tnum">
          <Icon name="video" size={13} />
          {ordered.length}
        </span>
        {view !== 'hero' && pageCount > 1 && (
          <span className="camwall__pglbl tnum" title="Página de canales del NVR">{curPage + 1}/{pageCount}</span>
        )}
        <IconButton
          icon="refresh"
          size="sm"
          label="Actualizar feeds"
          onClick={() => setReloadKey((k) => k + 1)}
        />
      </div>

      {loading ? (
        <div className="camwall__state">
          <Spinner size={22} />
          <span>Cargando cámaras del sitio…</span>
        </div>
      ) : error ? (
        <div className="camwall__state">
          <EmptyState icon="alert" title="Error al cargar cámaras">
            {error}
          </EmptyState>
        </div>
      ) : view === 'hero' ? (
        // Hero: la cámara del evento OCUPA el recuadro; las demás son mini-canales
        // en DOS columnas verticales de overlay — izquierda «Interior», derecha
        // «Perímetro» (según la etiqueta de cada cámara). Clic en una la sube al
        // recuadro grande. El Hero trae la mejor calidad (main), con toggle a sub.
        <div className={`camwall__stage camwall__stage--cols${openCol ? ` is-open-${openCol}` : ''}`}>
          {/* IZQUIERDA · Interior — botón-pestaña que despliega su columna on-demand */}
          {interiorCams.length > 0 && (
            openCol === 'interior' ? (
              <div className="camwall__col camwall__col--left">
                <button type="button" className="camwall__col-lbl camwall__col-lbl--btn" onClick={() => setOpenCol(null)} title="Contraer Interior">
                  <Icon name="building" size={12} /> Interior <span className="camwall__col-n">{interiorCams.length}</span>
                  <span className="camwall__col-x"><Icon name="chevron" size={13} /></span>
                </button>
                <div className="camwall__col-scroll">
                  {interiorCams.map((cam) => <ChannelMini key={cam.id} cam={cam} heroId={heroId} sourceId={sourceId} p={p} onPick={setSpotId} />)}
                </div>
              </div>
            ) : (
              <button type="button" className="camwall__coltab camwall__coltab--left" onClick={() => setOpenCol('interior')} title="Mostrar cámaras Interior">
                <Icon name="building" size={15} />
                <span className="camwall__coltab-tx">Interior</span>
                <span className="camwall__coltab-n">{interiorCams.length}</span>
              </button>
            )
          )}

          <div className="camwall__big">
            <CameraTile
              camera={heroCam}
              isSource={heroCam.id === sourceId}
              live
              quality={heroQuality}
              size="hero"
              priority={p}
              eventTs={evTs}
              highlightId={heroCam.id === sourceId ? triggerId : null}
              hotspots={heroHots}
              onFollowHotspot={(tid) => setSpotId(tid)}
            />
          </div>

          {/* DERECHA · Perímetro */}
          {perimeterCams.length > 0 && (
            openCol === 'perimeter' ? (
              <div className="camwall__col camwall__col--right">
                <button type="button" className="camwall__col-lbl camwall__col-lbl--btn" onClick={() => setOpenCol(null)} title="Contraer Perímetro">
                  <span className="camwall__col-x"><Icon name="chevron" size={13} /></span>
                  <Icon name="shield" size={12} /> Perímetro <span className="camwall__col-n">{perimeterCams.length}</span>
                </button>
                <div className="camwall__col-scroll">
                  {perimeterCams.map((cam) => <ChannelMini key={cam.id} cam={cam} heroId={heroId} sourceId={sourceId} p={p} onPick={setSpotId} />)}
                </div>
              </div>
            ) : (
              <button type="button" className="camwall__coltab camwall__coltab--right" onClick={() => setOpenCol('perimeter')} title="Mostrar cámaras Perímetro">
                <Icon name="shield" size={15} />
                <span className="camwall__coltab-tx">Perímetro</span>
                <span className="camwall__coltab-n">{perimeterCams.length}</span>
              </button>
            )
          )}
        </div>
      ) : (
        <>
        {pageCount > 1 && (
          <button type="button" className="camwall__edge camwall__edge--prev" disabled={curPage <= 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))} aria-label="Canales anteriores" title="Canales anteriores del NVR">
            <Icon name="chevron" size={26} />
          </button>
        )}
        {pageCount > 1 && (
          <button type="button" className="camwall__edge camwall__edge--next" disabled={curPage >= pageCount - 1}
            onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))} aria-label="Más canales" title="Más canales del NVR">
            <Icon name="chevron" size={26} />
          </button>
        )}
        <div className={`camwall__mosaic camwall__mosaic--${view}`}>
          {gridCams.map((cam) => (
            <CameraTile
              key={cam.id}
              camera={cam}
              isSource={cam.id === sourceId}
              live
              liveGrid
              bare
              quality={liveQuality}
              size="md"
              priority={p}
              eventTs={cam.id === sourceId ? evTs : null}
              highlightId={cam.id === sourceId ? triggerId : null}
              showSpotlight
              onSpotlight={() => {
                setSpotId(cam.id)
                setView('hero')
              }}
            />
          ))}
        </div>
        </>
      )}

      {/* Dock inferior centrado: selector de vista (Hero / 2×2 / 3×3) + toggle de
          calidad HD/SD, juntos, sobre el video (estilo reproductor). */}
      {!loading && !error && (
        <div className="camwall__dock">
          <Segmented value={view} onChange={(v) => { setView(v); setPage(0) }} options={viewOptions} />
          <button type="button" className="camwall__qtoggle" onClick={() => setHeroQuality((q) => (q === 'main' ? 'sub' : 'main'))}
            title={heroQuality === 'main' ? 'Calidad alta (main) · tocar para sub' : 'Calidad baja (sub) · tocar para main'}>
            <Icon name="gauge" size={13} /> {heroQuality === 'main' ? 'HD' : 'SD'}
          </button>
        </div>
      )}
    </div>
  )
}

// ChannelMini — mini-canal de una columna del Hero (Interior / Perímetro).
// Vertical, con scroll en su columna. Clic → sube la cámara al recuadro grande.
function ChannelMini({ cam, heroId, sourceId, p, onPick }) {
  return (
    <button
      type="button"
      className={`camwall__mini ${cam.id === heroId ? 'is-active' : ''} ${cam.id === sourceId ? 'is-source' : ''}`}
      onClick={() => onPick(cam.id)}
      title={cam.name}
    >
      <CameraTile
        camera={cam}
        isSource={cam.id === sourceId}
        live={cam.id === heroId}
        size="sm"
        priority={p}
      />
      {cam.id === sourceId ? <span className="camwall__mini-tag">EVENTO</span> : null}
      <span className="camwall__mini-name">{cam.name}</span>
    </button>
  )
}
