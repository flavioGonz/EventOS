// Videowall — muro de cámaras multipantalla para centro de monitoreo.
// Layouts (2×2/3×3/4×4/spotlight), asignar cámaras a celdas, guardar presets,
// AUTO-SPOTLIGHT por alarma (P1/P2 → su cámara salta a la celda principal),
// CARRUSEL (rota cámaras), y POP-OUT a otra ventana/monitor. Las celdas usan
// snapshot near-live (bajo costo); la celda en vivo usa go2rtc (RTSP directo de
// la cámara, transcodificado → SPS válido). Tope de vivos concurrentes para no
// exceder el límite de RTSP del NVR ni saturar la CPU del transcode.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon, Segmented, Button } from '../ui/primitives.jsx'
import { Go2RtcView } from './CameraLive.jsx'
import NvrPlayback from './NvrPlayback.jsx'
import { api, getAdminToken } from '../lib/adminApi.js'
import { useConsole } from '../lib/socket.js'

const LAYOUTS = [
  { value: '2x2', label: '2×2', cells: 4 },
  { value: '3x3', label: '3×3', cells: 9 },
  { value: '4x4', label: '4×4', cells: 16 },
  { value: 'spot', label: 'Spotlight 1+5', cells: 6 },
]
const layoutCells = (v) => (LAYOUTS.find((l) => l.value === v) || LAYOUTS[0]).cells
const LS_PRESETS = 'eventos.wall.presets'
// Tope de celdas en vivo a la vez. Cada vivo = 1 sesión RTSP→transcode contra el
// NVR; pasarse satura el NVR (límite de streams concurrentes) y la CPU.
const WALL_MAX_LIVE = 6

function loadLS(key, fallback) { try { const r = localStorage.getItem(key); return r ? JSON.parse(r) : fallback } catch { return fallback } }
function saveLS(key, val) { try { localStorage.setItem(key, JSON.stringify(val)) } catch { /* ignore */ } }

// Celda: snapshot near-live, o vivo go2rtc si `live`. Si el snapshot falla
// (cámara sin señal) muestra un estado claro en vez de imagen rota.
function WallCell({ cam, live, focused, index, onClick, onClear, onToggleLive, onMoveCell, onPlayback, editTrack, cameras, onFollow, onSaveLinks }) {
  const [t, setT] = useState(0)
  const [over, setOver] = useState(false)
  const [failed, setFailed] = useState(false)
  const [pending, setPending] = useState(null) // {x,y} normalizado para nuevo hotspot
  const cellRef = useRef(null)
  const links = (cam && Array.isArray(cam.wallLinks)) ? cam.wallLinks : []
  useEffect(() => { setPending(null) }, [cam, editTrack])
  useEffect(() => {
    if (!cam || live) return
    setT(Date.now())
    const id = setInterval(() => setT(Date.now()), 2500) // near-live de bajo costo
    return () => clearInterval(id)
  }, [cam, live])
  useEffect(() => { setFailed(false) }, [cam, live])

  // Pantalla completa real (Fullscreen API) sobre la celda. Doble-clic la activa
  // / desactiva; también hay botón en la barra. La celda llena el monitor.
  const toggleFs = useCallback(() => {
    const el = cellRef.current
    if (!el) return
    if (document.fullscreenElement === el) { document.exitFullscreen?.() }
    else if (document.fullscreenElement) { document.exitFullscreen?.().then(() => el.requestFullscreen?.()) }
    else { el.requestFullscreen?.() }
  }, [])

  // Descargar el snapshot actual de la cámara como JPG.
  const downloadSnap = useCallback((e) => {
    e.stopPropagation()
    if (!cam) return
    const a = document.createElement('a')
    a.href = `/api/camera/${cam.id}/snapshot?t=${Date.now()}`
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    a.download = `${(cam.name || 'camara').replace(/\s+/g, '_')}-${stamp}.jpg`
    document.body.appendChild(a); a.click(); a.remove()
  }, [cam])

  // Visual tracking: en modo edición, clic sobre el video deja un punto donde
  // colocar un hotspot; se elige la cámara destino y se guarda en el servidor.
  const onSurfaceClick = (e) => {
    if (!editTrack || !cam) return
    const rect = cellRef.current.getBoundingClientRect()
    const x = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
    const y = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height))
    setPending({ x, y })
  }
  const addLink = (targetId) => {
    if (!targetId || !pending || !cam) return setPending(null)
    const tgt = cameras.find((cc) => cc.id === targetId)
    const link = { id: `lk_${Math.random().toString(36).slice(2, 8)}`, x: pending.x, y: pending.y, target: targetId, label: (tgt && tgt.name) || '' }
    onSaveLinks(cam.id, [...links, link]); setPending(null)
  }
  const removeLink = (lid) => onSaveLinks(cam.id, links.filter((l) => l.id !== lid))

  return (
    <div ref={cellRef} className={`wallcell${focused ? ' is-focus' : ''}${cam ? '' : ' is-empty'}${over ? ' is-dragover' : ''}`}
      onClick={onClick}
      onDoubleClick={(e) => { if (cam) { e.preventDefault(); toggleFs() } }}
      draggable={!!cam && !editTrack}
      onDragStart={(e) => { e.dataTransfer.setData('text/cell', String(index)); e.dataTransfer.effectAllowed = 'move' }}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (!over) setOver(true) }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); const from = Number(e.dataTransfer.getData('text/cell')); if (!Number.isNaN(from) && from !== index) onMoveCell(from, index) }}>
      {cam ? (
        <>
          {live
            ? <Go2RtcView deviceId={cam.id} />
            : (
              <>
                <img className="wallcell__img" alt="" src={`/api/camera/${cam.id}/snapshot${t ? `?t=${t}` : ''}`}
                  onLoad={() => setFailed(false)} onError={() => setFailed(true)} />
                {failed && <span className="wallcell__off"><Icon name="alert" size={18} /> sin señal</span>}
              </>
            )}
          <div className="wallcell__bar">
            <span className="wallcell__name">{cam.channel ? `#${cam.channel} ` : ''}{cam.name}</span>
            <span className="wallcell__sp" />
            <button type="button" className={`wallcell__btn${live ? ' is-on' : ''}`} title="En vivo"
              onClick={(e) => { e.stopPropagation(); onToggleLive() }}><Icon name="bolt" size={13} /></button>
            <button type="button" className="wallcell__btn" title="Grabación / eventos"
              onClick={(e) => { e.stopPropagation(); onPlayback() }}><Icon name="clock" size={13} /></button>
            <button type="button" className="wallcell__btn" title="Descargar foto"
              onClick={downloadSnap}><Icon name="download" size={13} /></button>
            <button type="button" className="wallcell__btn" title="Pantalla completa (doble-clic)"
              onClick={(e) => { e.stopPropagation(); toggleFs() }}><Icon name="expand" size={13} /></button>
            <button type="button" className="wallcell__btn" title="Quitar"
              onClick={(e) => { e.stopPropagation(); onClear() }}><Icon name="x" size={13} /></button>
          </div>
          {live && <span className="wallcell__live">● EN VIVO</span>}

          {(links.length > 0 || editTrack) && (
            <div className={`wallcell__hot${editTrack ? ' is-edit' : ''}`} onClick={onSurfaceClick}>
              {editTrack && <span className="wallcell__hothint"><Icon name="route" size={12} /> Clic para añadir cámara vecina</span>}
              {links.map((l) => {
                const tgt = cameras.find((cc) => cc.id === l.target)
                return (
                  <button key={l.id} type="button" className="wallhot" style={{ left: `${l.x * 100}%`, top: `${l.y * 100}%` }}
                    title={editTrack ? 'Quitar' : `Ir a ${(tgt && tgt.name) || l.label || 'cámara'}`}
                    onClick={(e) => { e.stopPropagation(); if (editTrack) removeLink(l.id); else onFollow(l.target) }}>
                    <Icon name="camera" size={13} />
                    <span className="wallhot__lbl">{l.label || (tgt && tgt.name) || '—'}</span>
                  </button>
                )
              })}
              {pending && (
                <div className="wallhot__pick" style={{ left: `${pending.x * 100}%`, top: `${pending.y * 100}%` }} onClick={(e) => e.stopPropagation()}>
                  <select autoFocus defaultValue="" onChange={(e) => addLink(e.target.value)}>
                    <option value="" disabled>Cámara destino…</option>
                    {cameras.filter((cc) => cc.id !== cam.id).map((cc) => (
                      <option key={cc.id} value={cc.id}>{cc.channel ? `#${cc.channel} ` : ''}{cc.name}</option>
                    ))}
                  </select>
                  <button type="button" onClick={() => setPending(null)} aria-label="Cancelar"><Icon name="x" size={12} /></button>
                </div>
              )}
            </div>
          )}
        </>
      ) : (
        <div className="wallcell__empty"><Icon name="camera" size={22} /><span>Asignar cámara</span></div>
      )}
    </div>
  )
}

export default function Videowall() {
  // `screen` = id de monitor; cada ventana tiene su propia config (multi-monitor
  // en un solo PC: pop-out a ventanas independientes, una por monitor físico).
  const params = useMemo(() => new URLSearchParams(window.location.search), [])
  const isPopout = params.get('popout') === '1'
  const screen = params.get('screen') || '1'
  const LS = `eventos.wall.v1.${screen}`
  const initial = loadLS(LS, { layout: 'spot', cells: [], live: [] })
  const [layout, setLayout] = useState(initial.layout || 'spot')
  const [cells, setCells] = useState(initial.cells || [])      // ids por celda
  const [live, setLive] = useState(initial.live || [])         // bool por celda
  const [focus, setFocus] = useState(0)                        // celda seleccionada
  const [cameras, setCameras] = useState([])
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickQuery, setPickQuery] = useState('')
  const [autoSpot, setAutoSpot] = useState(!!initial.autoSpot)
  const [carousel, setCarousel] = useState(false)
  const [carouselSec, setCarouselSec] = useState(initial.carouselSec || 10)
  const [presets, setPresets] = useState(() => loadLS(LS_PRESETS, {}))
  const [pbCam, setPbCam] = useState(null) // cámara con el modal de grabación abierto
  const [editTrack, setEditTrack] = useState(false) // modo edición de hotspots de seguimiento

  const n = layoutCells(layout)
  const { events } = useConsole(null) // solo para escuchar alarmas (sin identidad)
  const lastAlertId = useRef(null)

  // Cargar cámaras (públicas).
  useEffect(() => {
    fetch('/api/cameras').then((r) => (r.ok ? r.json() : null)).then((d) => {
      if (d && d.cameras) setCameras(d.cameras.filter((c) => c.type !== 'nvr'))
    }).catch(() => {})
  }, [])

  // Persistir estado.
  useEffect(() => { saveLS(LS, { layout, cells, live, autoSpot, carouselSec }) }, [layout, cells, live, autoSpot, carouselSec])

  // Normaliza longitud de arrays al cambiar layout.
  useEffect(() => {
    setCells((c) => Array.from({ length: n }, (_, i) => c[i] || null))
    setLive((l) => Array.from({ length: n }, (_, i) => (layout === 'spot' && i === 0 ? true : !!l[i])))
    if (focus >= n) setFocus(0)
  }, [layout]) // eslint-disable-line react-hooks/exhaustive-deps

  // TOPE de vivos concurrentes: mantiene el orden en que se encendieron y, si se
  // pasa de WALL_MAX_LIVE, apaga las más viejas. Declarativo → cubre toggle,
  // auto-spotlight y carrusel sin lógica duplicada.
  const liveOrder = useRef([])
  useEffect(() => {
    const on = live.map((v, k) => (v ? k : -1)).filter((k) => k >= 0)
    liveOrder.current = [...liveOrder.current.filter((k) => on.includes(k)), ...on.filter((k) => !liveOrder.current.includes(k))]
    if (liveOrder.current.length > WALL_MAX_LIVE) {
      const drop = liveOrder.current.slice(0, liveOrder.current.length - WALL_MAX_LIVE)
      liveOrder.current = liveOrder.current.slice(drop.length)
      setLive((l) => { const nx = l.slice(); drop.forEach((k) => { nx[k] = false }); return nx })
    }
  }, [live])
  const liveCount = useMemo(() => live.filter(Boolean).length, [live])

  const camById = useMemo(() => Object.fromEntries(cameras.map((c) => [c.id, c])), [cameras])

  const assign = useCallback((camId) => {
    setCells((c) => { const next = c.slice(); next[focus] = camId; return next })
    setPickerOpen(false)
  }, [focus])
  const clearCell = (i) => setCells((c) => { const next = c.slice(); next[i] = null; return next })
  const toggleLive = (i) => setLive((l) => { const next = l.slice(); next[i] = !next[i]; return next })
  // Reemplaza la cámara de una celda (al hacer clic en un hotspot de seguimiento).
  const followInCell = useCallback((i, targetId) => {
    if (!targetId) return
    setCells((c) => { const next = c.slice(); next[i] = targetId; return next }); setFocus(i)
  }, [])
  // Guarda los hotspots de una cámara: optimista en memoria + persistencia admin.
  const saveLinks = useCallback(async (camId, links) => {
    setCameras((cs) => cs.map((c) => (c.id === camId ? { ...c, wallLinks: links } : c)))
    try { await api.put(`/devices/${camId}`, { wallLinks: links }) }
    catch (e) {
      const msg = e && e.status === 401 ? 'Necesitás iniciar sesión de supervisor para guardar el seguimiento.' : 'No se pudo guardar el seguimiento.'
      window.alert(msg)
    }
  }, [])
  // Drag & drop: arrastrar una celda sobre otra las INTERCAMBIA (cámara + estado vivo).
  const moveCell = useCallback((from, to) => {
    setCells((c) => { const n = c.slice();[n[from], n[to]] = [n[to], n[from]]; return n })
    setLive((l) => { const n = l.slice();[n[from], n[to]] = [n[to], n[from]]; return n })
  }, [])

  // AUTO-SPOTLIGHT: al llegar un evento P1/P2 nuevo, su cámara salta a la celda 0.
  useEffect(() => {
    if (!autoSpot || !events || !events.length) return
    const top = events.find((e) => (e.priority ?? 5) <= 2 && e.status !== 'resolved')
    if (!top || top.id === lastAlertId.current) return
    const camId = top.source && top.source.deviceId
    if (!camId || !camById[camId]) return
    lastAlertId.current = top.id
    if (layout !== 'spot') setLayout('spot')
    setCells((c) => { const next = c.slice(); next[0] = camId; return next })
    setLive((l) => { const next = l.slice(); next[0] = true; return next })
    setFocus(0)
  }, [events, autoSpot, camById, layout])

  // CARRUSEL: rota las cámaras por las celdas cada N segundos.
  useEffect(() => {
    if (!carousel || cameras.length === 0) return
    let offset = 0
    const id = setInterval(() => {
      offset = (offset + n) % Math.max(1, cameras.length)
      setCells(() => Array.from({ length: n }, (_, i) => cameras[(offset + i) % cameras.length]?.id || null))
    }, Math.max(3, carouselSec) * 1000)
    return () => clearInterval(id)
  }, [carousel, carouselSec, cameras, n])

  const savePreset = () => {
    const name = window.prompt('Nombre del preset:')
    if (!name) return
    const next = { ...presets, [name]: { layout, cells, live } }
    setPresets(next); saveLS(LS_PRESETS, next)
  }
  const loadPreset = (name) => {
    const p = presets[name]; if (!p) return
    setLayout(p.layout); setCells(p.cells); setLive(p.live || [])
  }
  const delPreset = (name) => {
    const next = { ...presets }; delete next[name]
    setPresets(next); saveLS(LS_PRESETS, next)
  }
  const popOut = () => window.open(`/wall?popout=1&screen=${screen}`, `eventos-wall-${screen}`, 'width=1600,height=900')
  const newMonitor = () => {
    let last = Number(localStorage.getItem('eventos.wall.lastScreen') || 1)
    if (!isFinite(last)) last = 1
    const next = Math.max(last, Number(screen) || 1) + 1
    try { localStorage.setItem('eventos.wall.lastScreen', String(next)) } catch { /* ignore */ }
    window.open(`/wall?popout=1&screen=${next}`, `eventos-wall-${next}`, 'width=1600,height=900,menubar=no,toolbar=no')
  }

  // Cámaras agrupadas por sitio para el selector, con filtro de búsqueda.
  const grouped = useMemo(() => {
    const q = pickQuery.trim().toLowerCase()
    const m = new Map()
    for (const c of cameras) {
      if (q && !`${c.name || ''} #${c.channel || ''} ${c.site || ''}`.toLowerCase().includes(q)) continue
      const s = c.site || 'Sin sitio'; if (!m.has(s)) m.set(s, []); m.get(s).push(c)
    }
    return [...m.entries()]
  }, [cameras, pickQuery])

  return (
    <div className={`wall${isPopout ? ' wall--popout' : ''}`}>
      <header className="wall__toolbar">
        {!isPopout && <a className="wall__back" href="/" title="Volver a la consola"><Icon name="console" size={16} /></a>}
        <span className="wall__brand"><Icon name="grid" size={16} /> Videowall{screen !== '1' ? ` · Monitor ${screen}` : ''}</span>
        <Segmented value={layout} onChange={setLayout} options={LAYOUTS.map((l) => ({ value: l.value, label: l.label }))} />
        {liveCount > 0 && (
          <span className={`wall__livecount${liveCount >= WALL_MAX_LIVE ? ' is-max' : ''}`} title="Cámaras en vivo a la vez (tope para proteger el NVR y la CPU)">
            <Icon name="bolt" size={12} /> {liveCount}/{WALL_MAX_LIVE}
          </span>
        )}
        <span className="wall__sp" />
        <Button variant={autoSpot ? 'primary' : 'ghost'} size="sm" icon="bolt" onClick={() => setAutoSpot((v) => !v)} title="La cámara del evento P1/P2 salta a la celda principal">Auto-spotlight</Button>
        <Button variant={carousel ? 'primary' : 'ghost'} size="sm" icon="refresh" onClick={() => setCarousel((v) => !v)}>Carrusel</Button>
        {carousel && (
          <input className="wall__num" type="number" min="3" max="120" value={carouselSec}
            onChange={(e) => setCarouselSec(Number(e.target.value) || 10)} title="Segundos por rotación" />
        )}
        <Button variant="ghost" size="sm" icon="camera" onClick={() => setPickerOpen((v) => !v)}>Cámaras</Button>
        <Button variant={editTrack ? 'primary' : 'ghost'} size="sm" icon="route"
          onClick={() => setEditTrack((v) => { const nv = !v; if (nv && !getAdminToken()) window.alert('Para editar el seguimiento iniciá sesión de supervisor (panel de administración) en este navegador; sin eso no se podrá guardar.'); return nv })}
          title="Colocar iconos de cámaras vecinas sobre el video (seguimiento). Se guarda en el servidor.">Seguimiento</Button>
        <Button variant="ghost" size="sm" icon="check" onClick={savePreset}>Guardar</Button>
        {Object.keys(presets).length > 0 && (
          <select className="wall__presets" value="" onChange={(e) => { if (e.target.value) loadPreset(e.target.value) }}>
            <option value="">Presets…</option>
            {Object.keys(presets).map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        )}
        <Button variant="ghost" size="sm" icon="plus" onClick={newMonitor} title="Abrir otra ventana de wall (arrastrala a otro monitor)">Monitor</Button>
        {!isPopout && <Button variant="ghost" size="sm" icon="expand" onClick={popOut} title="Abrir este wall en ventana aparte">Pop-out</Button>}
      </header>

      <div className="wall__body">
        <div className={`wall__grid wall--${layout}`}>
          {Array.from({ length: n }, (_, i) => (
            <WallCell key={i} index={i} cam={camById[cells[i]] || null} live={!!live[i]} focused={focus === i}
              onClick={() => { setFocus(i); if (!cells[i]) setPickerOpen(true) }}
              onClear={() => clearCell(i)} onToggleLive={() => toggleLive(i)} onMoveCell={moveCell}
              onPlayback={() => setPbCam(camById[cells[i]] || null)}
              editTrack={editTrack} cameras={cameras}
              onFollow={(tid) => followInCell(i, tid)} onSaveLinks={saveLinks} />
          ))}
        </div>

        {pickerOpen && (
          <aside className="wall__picker">
            <header className="wall__pickhead">
              <span>Celda {focus + 1} · elegí cámara</span>
              <button type="button" onClick={() => setPickerOpen(false)}><Icon name="x" size={16} /></button>
            </header>
            <div className="wall__picksearch">
              <Icon name="search" size={14} />
              <input type="text" value={pickQuery} placeholder="Buscar cámara…" autoFocus
                onChange={(e) => setPickQuery(e.target.value)} />
              {pickQuery && <button type="button" onClick={() => setPickQuery('')} title="Limpiar"><Icon name="x" size={13} /></button>}
            </div>
            <div className="wall__picklist">
              {grouped.map(([site, cams]) => (
                <div key={site} className="wall__pickgrp">
                  <p className="wall__picksite">{site}</p>
                  {cams.map((c) => (
                    <button key={c.id} type="button" className="wall__pickitem" onClick={() => assign(c.id)}>
                      <Icon name="camera" size={13} /> {c.channel ? `#${c.channel} ` : ''}{c.name}
                    </button>
                  ))}
                </div>
              ))}
              {grouped.length === 0 && <p className="help-block">{cameras.length === 0 ? 'No hay cámaras.' : 'Sin resultados.'}</p>}
            </div>
          </aside>
        )}
      </div>

      {Object.keys(presets).length > 0 && (
        <div className="wall__presetbar">
          {Object.keys(presets).map((name) => (
            <span key={name} className="wall__presetchip">
              <button type="button" onClick={() => loadPreset(name)}>{name}</button>
              <button type="button" className="wall__presetx" onClick={() => delPreset(name)} title="Borrar"><Icon name="x" size={11} /></button>
            </span>
          ))}
        </div>
      )}

      {pbCam && createPortal(
        <div className="modal-scrim" onClick={() => setPbCam(null)}>
          <div className="wallpb" onClick={(e) => e.stopPropagation()}>
            <header className="wallpb__head">
              <span className="wallpb__title"><Icon name="clock" size={16} /> Grabación · {pbCam.channel ? `#${pbCam.channel} ` : ''}{pbCam.name}</span>
              <button type="button" className="wallpb__x" onClick={() => setPbCam(null)} aria-label="Cerrar"><Icon name="x" size={18} /></button>
            </header>
            <div className="wallpb__body">
              <NvrPlayback
                event={{ id: `live_${pbCam.id}`, ts: Date.now(), source: { deviceId: pbCam.id } }}
                onClose={() => setPbCam(null)} />
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}
