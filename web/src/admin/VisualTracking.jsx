// VisualTracking — "Plano de cámaras": una imagen (plano o foto de la escena)
// sobre la que se arrastran iconos de cámara para vincular canales a lo que se ve
// y navegar la escena rápido (clic en un marcador → abre esa cámara en vivo).
// El plano se guarda por sitio (site.floorplan = { bg, cams:[{deviceId,x,y}] }).
import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon, Select, TextInput, Button, Field } from '../ui/primitives.jsx'
import { collectionApi, unwrap } from '../lib/adminApi.js'
import { PageHead, Loading, SectionHelp, useToast } from './_shared.jsx'
import { CameraModal } from './CameraWallView.jsx'

const clamp = (v) => Math.max(2.5, Math.min(97.5, v))

function Marker({ m, cam, edit, canvasRef, onMove, onOpen, onRemove }) {
  const moved = useRef(false)
  const onDown = (e) => {
    if (!edit) { onOpen(); return }
    e.preventDefault(); e.stopPropagation(); moved.current = false
    const move = (ev) => {
      moved.current = true
      const r = canvasRef.current.getBoundingClientRect()
      onMove(clamp(((ev.clientX - r.left) / r.width) * 100), clamp(((ev.clientY - r.top) / r.height) * 100))
    }
    const up = () => {
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', up)
      if (!moved.current) onOpen()
    }
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', up)
  }
  return (
    <button type="button" className={`vtmark${edit ? ' is-edit' : ''}`} style={{ left: `${m.x}%`, top: `${m.y}%` }}
      onPointerDown={onDown} title={cam ? cam.name : 'Cámara'}>
      <span className="vtmark__pin"><Icon name="camera" size={14} /></span>
      <span className="vtmark__lbl">{cam ? cam.name : '—'}</span>
      {edit && <span className="vtmark__rm" onPointerDown={(e) => { e.stopPropagation(); onRemove() }} title="Quitar"><Icon name="x" size={11} /></span>}
    </button>
  )
}

export default function VisualTracking() {
  const toast = useToast()
  const [sites, setSites] = useState(null)
  const [devices, setDevices] = useState([])
  const [siteId, setSiteId] = useState('')
  const [bg, setBg] = useState('')
  const [markers, setMarkers] = useState([])
  const [edit, setEdit] = useState(true)
  const [open, setOpen] = useState(null)
  const [saving, setSaving] = useState(false)
  const canvasRef = useRef(null)

  useEffect(() => {
    collectionApi('sites').list().then((d) => { const s = unwrap(d, 'sites'); setSites(s); if (s[0]) setSiteId(s[0].id) }).catch(() => setSites([]))
    collectionApi('devices').list().then((d) => setDevices(unwrap(d, 'devices'))).catch(() => {})
  }, [])

  // Cargar el plano del sitio elegido.
  useEffect(() => {
    if (!sites) return
    const s = sites.find((x) => x.id === siteId)
    const fp = (s && s.floorplan) || {}
    setBg(fp.bg || '')
    setMarkers(Array.isArray(fp.cams) ? fp.cams.filter((c) => c && c.deviceId) : [])
  }, [siteId, sites])

  const siteCams = useMemo(() => devices.filter((d) => d.siteId === siteId && d.type !== 'alarm'), [devices, siteId])
  const placed = useMemo(() => new Set(markers.map((m) => m.deviceId)), [markers])
  const palette = siteCams.filter((d) => !placed.has(d.id))
  const camOf = (id) => devices.find((d) => d.id === id)

  const onDrop = (e) => {
    e.preventDefault()
    const id = e.dataTransfer.getData('cam')
    if (!id || !canvasRef.current) return
    const r = canvasRef.current.getBoundingClientRect()
    const x = clamp(((e.clientX - r.left) / r.width) * 100)
    const y = clamp(((e.clientY - r.top) / r.height) * 100)
    setMarkers((m) => [...m.filter((k) => k.deviceId !== id), { deviceId: id, x, y }])
  }
  const moveMarker = (id, x, y) => setMarkers((m) => m.map((k) => (k.deviceId === id ? { ...k, x, y } : k)))
  const removeMarker = (id) => setMarkers((m) => m.filter((k) => k.deviceId !== id))

  const save = async () => {
    const s = sites.find((x) => x.id === siteId)
    if (!s) return
    setSaving(true)
    try {
      await collectionApi('sites').update(siteId, { ...s, floorplan: { bg, cams: markers } })
      toast('Plano guardado')
    } catch (e) { toast(e.message || 'No se pudo guardar', 'error') } finally { setSaving(false) }
  }

  if (sites === null) return <Loading label="Cargando…" />

  const openCam = (id) => { const c = camOf(id); if (c) setOpen({ id: c.id, name: c.name, channel: c.channel, zone: c.zone, ip: c.ip }) }

  return (
    <div className="anim-rise vt">
      <PageHead title="Plano de cámaras" subtitle="Ubicá las cámaras sobre la escena y navegá con un clic."
        actions={
          <div className="head-actions">
            <button type="button" className={`vt-toggle${edit ? '' : ' is-on'}`} onClick={() => setEdit((v) => !v)}>
              <Icon name={edit ? 'edit' : 'play'} size={15} /> {edit ? 'Editando' : 'Navegar'}
            </button>
            {edit && <Button variant="primary" icon="check" onClick={save} disabled={saving || !siteId}>{saving ? 'Guardando…' : 'Guardar plano'}</Button>}
          </div>
        } />

      <SectionHelp id="tracking" icon="map" title="Cómo usar el plano">
        Subí una imagen del plano o de la escena (pegá su URL), arrastrá las cámaras del panel a su posición real, y guardá. En modo «Navegar», un clic en cualquier cámara la abre en vivo — ideal para seguir a alguien por la escena.
      </SectionHelp>

      <div className="form-grid form-grid--2">
        <Field label="Sitio">
          <Select value={siteId} onChange={(e) => setSiteId(e.target.value)}>
            {sites.length === 0 && <option value="">— Sin sitios —</option>}
            {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </Field>
        {edit && (
          <Field label="Imagen de fondo (URL del plano o foto)" hint="Opcional. Si está vacío, se usa una cuadrícula.">
            <TextInput value={bg} onChange={(e) => setBg(e.target.value)} placeholder="https://…/plano.png" />
          </Field>
        )}
      </div>

      <div className="vt-wrap">
        {edit && (
          <aside className="vt-palette">
            <p className="vt-palette__title"><Icon name="camera" size={14} /> Cámaras del sitio</p>
            {palette.length === 0
              ? <p className="help-block">{siteCams.length === 0 ? 'Este sitio no tiene cámaras.' : 'Todas ubicadas en el plano.'}</p>
              : palette.map((d) => (
                <div key={d.id} className="vt-pal" draggable onDragStart={(e) => e.dataTransfer.setData('cam', d.id)}>
                  <Icon name="camera" size={14} /><span>{d.name}</span><Icon name="expand" size={13} className="vt-pal__grip" />
                </div>
              ))}
            <p className="help-block u-mt-12">Arrastrá cada cámara a su lugar en el plano.</p>
          </aside>
        )}

        <div className="vt-canvas-box">
          <div ref={canvasRef} className={`vt-canvas${bg ? ' has-bg' : ''}`}
            style={bg ? { backgroundImage: `url("${bg}")` } : undefined}
            onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
            {!bg && <div className="vt-canvas__hint"><Icon name="map" size={26} /><span>Pegá la URL de un plano o foto arriba, o ubicá las cámaras sobre la cuadrícula.</span></div>}
            {markers.map((m) => (
              <Marker key={m.deviceId} m={m} cam={camOf(m.deviceId)} edit={edit} canvasRef={canvasRef}
                onMove={(x, y) => moveMarker(m.deviceId, x, y)} onOpen={() => openCam(m.deviceId)} onRemove={() => removeMarker(m.deviceId)} />
            ))}
          </div>
        </div>
      </div>

      {open && <CameraModal cam={open} onClose={() => setOpen(null)} />}
    </div>
  )
}
