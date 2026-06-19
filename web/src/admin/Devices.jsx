// Dispositivos — listado. La edición es una página dedicada (DeviceEdit), no un modal.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, IconButton, Switch, Icon, Segmented } from '../ui/primitives.jsx'
import { useAdminData, collectionApi, unwrap } from '../lib/adminApi.js'
import { deviceTypeLabel, DEVICE_TYPE_ICON } from '../lib/labels.js'
import { CollectionView, PageHead, useToast, confirmDelete } from './_shared.jsx'
import CameraWallView from './CameraWallView.jsx'

// Miniatura del dispositivo en la tabla: snapshot de la cámara (perezoso, solo
// al entrar en viewport) o icono del tipo para NVR/alarmas. Hace la lista visual.
function DeviceThumb({ device }) {
  const ref = useRef(null)
  const [vis, setVis] = useState(false)
  const [fail, setFail] = useState(false)
  const isCam = !!(device && device.id && /hikvision|onvif|camera|generic/i.test(device.type || '') && device.ip && device.isapiPort)
  useEffect(() => {
    const el = ref.current; if (!el) return
    const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) setVis(true) }), { rootMargin: '140px' })
    io.observe(el); return () => io.disconnect()
  }, [])
  return (
    <span ref={ref} className="devthumb" aria-hidden="true">
      {isCam && vis && !fail
        ? <img className="devthumb__img" alt="" loading="lazy" src={`/api/camera/${device.id}/snapshot`} onError={() => setFail(true)} />
        : <span className="devthumb__ph"><Icon name={DEVICE_TYPE_ICON[device.type] || 'device'} size={16} /></span>}
    </span>
  )
}

export default function Devices() {
  const { items, loading, error, reload, update, remove } = useAdminData('devices')
  const toast = useToast()
  const navigate = useNavigate()
  const [sites, setSites] = useState([])
  const [q, setQ] = useState('')
  const [view, setView] = useState('table') // table | wall
  const [expanded, setExpanded] = useState({})

  useEffect(() => {
    collectionApi('sites').list().then((d) => setSites(unwrap(d, 'sites'))).catch(() => {})
  }, [])

  const siteName = useMemo(() => {
    const m = {}; sites.forEach((s) => { m[s.id] = s.name }); return m
  }, [sites])

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase()
    if (!term) return items
    return items.filter((d) =>
      [d.name, d.vendor, d.ip, d.type].filter(Boolean).some((v) => String(v).toLowerCase().includes(term)))
  }, [items, q])

  const edit = (d) => navigate(`/admin/devices/${d.id}`)
  const del = async (e, d) => {
    e.stopPropagation()
    if (!confirmDelete(d.name)) return
    try { await remove(d.id); toast('Dispositivo eliminado') } catch (err) { toast(err.message, 'error') }
  }
  const toggleEnabled = async (d) => {
    try { await update(d.id, { ...d, enabled: !d.enabled }) } catch (e) { toast(e.message, 'error') }
  }

  // Cabecera unificada: [conmutador de vista] | [Descubrir] [Nuevo]
  // Mismo orden y agrupación en Tabla y en Muro (consistencia).
  const headActions = (
    <div className="head-actions">
      <Segmented value={view} onChange={setView} options={[{ value: 'table', label: 'Tabla' }, { value: 'wall', label: 'Muro' }]} />
      <span className="head-actions__sep" aria-hidden="true" />
      <Button variant="secondary" icon="search" onClick={() => navigate('/admin/devices/discover')}>Descubrir equipo</Button>
      <Button variant="secondary" icon="rules" onClick={() => navigate('/admin/devices/wizard')}>Asistente</Button>
      <Button variant="primary" icon="plus" onClick={() => navigate('/admin/devices/new')}>Nuevo dispositivo</Button>
    </div>
  )

  // Vista "Muro": cámaras agrupadas por cliente y NVR, snapshot near-live + vivo al abrir.
  if (view === 'wall') {
    return (
      <div className="anim-rise">
        <PageHead title="Dispositivos" subtitle="Muro de cámaras agrupado por cliente y NVR." actions={headActions} />
        {loading ? <p className="help-block">Cargando…</p> : <CameraWallView devices={items} />}
      </div>
    )
  }

  return (
    <CollectionView
      title="Dispositivos" subtitle="Cámaras, NVR y centrales que generan eventos hacia EventOS."
      help={{ id: 'devices', icon: 'device', title: '¿Qué es un dispositivo?',
        text: 'Cada cámara, NVR o central de alarma que envía eventos a EventOS. Cargá su IP y credenciales para ver el video en vivo, y asignale un sitio y una prioridad. Las cámaras detrás de un NVR usan el campo «IP directa de cámara» para obtener video limpio por la VPN. Usá el botón Muro para ver todas las cámaras en vivo.' }}
      headActions={headActions}
      search={{ value: q, onChange: setQ, placeholder: 'Buscar por nombre, IP, tipo…' }}
      loading={loading} error={error} onRetry={reload} loadingCols={8}
      isEmpty={items.length === 0}
      empty={{ icon: 'device', title: 'Sin dispositivos', children: 'Registra cámaras y centrales para recibir eventos.' }}
      isNoResults={items.length > 0 && filtered.length === 0}
      noResults={{ children: 'Ningún dispositivo coincide con la búsqueda.' }}
    >
      <table className="adm-table">
        <thead><tr>
          <th><span className="th-ic"><Icon name="device" size={13} />Nombre</span></th>
          <th><span className="th-ic"><Icon name="camera" size={13} />Tipo</span></th>
          <th><span className="th-ic"><Icon name="shield" size={13} />Fabricante</span></th>
          <th><span className="th-ic"><Icon name="globe" size={13} />IP</span></th>
          <th><span className="th-ic"><Icon name="hash" size={13} />Canal</span></th>
          <th><span className="th-ic"><Icon name="site" size={13} />Sitio</span></th>
          <th><span className="th-ic"><Icon name="online" size={13} />Activo</span></th>
          <th />
        </tr></thead>
        <tbody>
          {(() => {
            const term = q.trim().toLowerCase()
            const match = (d) => !term || [d.name, d.vendor, d.ip, d.camIp, d.type].filter(Boolean).some((v) => String(v).toLowerCase().includes(term))
            const nvrs = items.filter((d) => d.type === 'nvr')
            const cams = items.filter((d) => d.type !== 'nvr')
            const byNvr = {}; const ungrouped = []
            for (const cam of cams) {
              const nvr = nvrs.find((n) => n.ip && n.ip === cam.ip && Number(n.isapiPort) === Number(cam.isapiPort))
              if (nvr) (byNvr[nvr.id] = byNvr[nvr.id] || []).push(cam)
              else ungrouped.push(cam)
            }
            const cells = (d) => (<>
              <td><span className="cell-type"><Icon name={DEVICE_TYPE_ICON[d.type] || 'device'} size={15} />{deviceTypeLabel(d.type)}</span></td>
              <td className="cell-dim">{d.vendor || '—'}</td>
              <td className="cell-mono">{d.camIp || d.ip || '—'}</td>
              <td className="cell-mono">{d.channel ?? '—'}</td>
              <td className="cell-dim">{siteName[d.siteId] || '—'}</td>
              <td onClick={(e) => e.stopPropagation()}><Switch checked={d.enabled} onChange={() => toggleEnabled(d)} aria-label={`Activar ${d.name}`} /></td>
              <td className="cell-actions" onClick={(e) => e.stopPropagation()}>
                <span className="row-actions">
                  <IconButton icon="edit" size="sm" label="Editar" onClick={() => edit(d)} />
                  <IconButton icon="trash" size="sm" label="Eliminar" onClick={(e) => del(e, d)} />
                </span>
              </td>
            </>)
            const camRow = (d) => (
              <tr key={d.id} className="adm-row--click adm-row--cam" onClick={() => edit(d)}>
                <td className="cell-name"><span className="dev-id"><DeviceThumb device={d} /><span className="dev-id__name">{d.name}</span></span></td>
                {cells(d)}
              </tr>
            )
            const rows = []
            for (const nvr of nvrs) {
              const group = byNvr[nvr.id] || []
              const visCams = group.filter(match)
              if (!(match(nvr) || visCams.length)) continue
              const open = expanded[nvr.id] === true
              rows.push(
                <tr key={nvr.id} className="adm-row--nvr" onClick={() => setExpanded((s) => ({ ...s, [nvr.id]: s[nvr.id] === false }))}>
                  <td className="cell-name"><span className="dev-id">
                    <span className={`dev-nvr-chev${open ? ' is-open' : ''}`}><Icon name="chevron" size={14} /></span>
                    <DeviceThumb device={nvr} /><span className="dev-id__name">{nvr.name}</span>
                    <span className="dev-nvr-count">{group.length} cám.</span>
                  </span></td>
                  {cells(nvr)}
                </tr>
              )
              if (open) (term ? visCams : group).forEach((cam) => rows.push(camRow(cam)))
            }
            ungrouped.filter(match).forEach((d) => rows.push(camRow(d)))
            return rows
          })()}
        </tbody>
      </table>
    </CollectionView>
  )
}
