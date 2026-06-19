// Sitios — listado. La edición es una página dedicada (SiteEdit), no un modal.
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { IconButton, Icon, Badge, Segmented } from '../ui/primitives.jsx'
import { useAdminData, collectionApi, unwrap } from '../lib/adminApi.js'
import { CollectionView, useToast, confirmDelete } from './_shared.jsx'

export default function Sites() {
  const { items, loading, error, reload, remove } = useAdminData('sites')
  const toast = useToast()
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState('all') // all | with | without
  const [devices, setDevices] = useState([])

  useEffect(() => {
    collectionApi('devices').list().then((d) => setDevices(unwrap(d, 'devices'))).catch(() => {})
  }, [])
  const deviceCount = useMemo(() => {
    const m = {}
    for (const d of devices) if (d.siteId) m[d.siteId] = (m[d.siteId] || 0) + 1
    return m
  }, [devices])

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase()
    return items.filter((s) => {
      const n = deviceCount[s.id] || 0
      if (filter === 'with' && n === 0) return false
      if (filter === 'without' && n > 0) return false
      if (!term) return true
      return [s.name, s.address, s.account, s.notes].filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(term))
    })
  }, [items, q, filter, deviceCount])

  const edit = (s) => navigate(`/admin/sites/${s.id}`)
  const del = async (e, s) => {
    e.stopPropagation()
    if (!confirmDelete(s.name)) return
    try { await remove(s.id); toast('Sitio eliminado') } catch (err) { toast(err.message, 'error') }
  }

  return (
    <CollectionView
      title="Sitios" subtitle="Clientes y ubicaciones: datos, lista de llamada, parlantes SIP y mapa."
      help={{ id: 'sites', icon: 'site', title: 'Sitios = clientes',
        text: 'Agrupan los dispositivos por cliente o ubicación. Definí la lista de llamada (contactos en orden), el número de emergencia, los parlantes SIP y las coordenadas en el mapa: todo eso aparece en el popup del operador cuando atiende un evento de ese sitio, para que sepa a quién llamar.' }}
      newLabel="Nuevo sitio" onNew={() => navigate('/admin/sites/new')}
      search={{ value: q, onChange: setQ, placeholder: 'Buscar por nombre, dirección, cuenta…' }}
      toolbarExtra={
        <Segmented value={filter} onChange={setFilter} options={[
          { value: 'all', label: 'Todos' },
          { value: 'with', label: 'Con dispositivos' },
          { value: 'without', label: 'Sin dispositivos' },
        ]} />
      }
      loading={loading} error={error} onRetry={reload} loadingCols={8}
      isEmpty={items.length === 0}
      empty={{ icon: 'site', title: 'Sin sitios', children: 'Crea tu primer sitio para asignar dispositivos.' }}
      isNoResults={items.length > 0 && filtered.length === 0}
    >
      <table className="adm-table adm-table--rows">
        <thead><tr>
          <th><span className="th-ic"><Icon name="building" size={13} />Cliente / Sitio</span></th>
          <th><span className="th-ic"><Icon name="pin" size={13} />Dirección</span></th>
          <th><span className="th-ic"><Icon name="hash" size={13} />Cuenta</span></th>
          <th><span className="th-ic"><Icon name="device" size={13} />Disp.</span></th>
          <th><span className="th-ic"><Icon name="phone" size={13} />Contactos</span></th>
          <th><span className="th-ic"><Icon name="speaker" size={13} />Parlantes</span></th>
          <th><span className="th-ic"><Icon name="map" size={13} />Mapa</span></th>
          <th />
        </tr></thead>
        <tbody className="stagger">
          {filtered.map((s) => {
            const n = deviceCount[s.id] || 0
            const hasGeo = Number.isFinite(Number(s.lat)) && Number.isFinite(Number(s.lng))
            return (
              <tr key={s.id} className="adm-row--click" onClick={() => edit(s)}>
                <td className="cell-name">{s.name}</td>
                <td className="cell-dim">{s.address || '—'}</td>
                <td className="cell-mono">{s.account || '—'}</td>
                <td>{n > 0 ? <Badge tone="accent">{n}</Badge> : <span className="muted">0</span>}</td>
                <td className="cell-dim">{(s.contacts && s.contacts.length) || 0}</td>
                <td className="cell-dim">{(s.speakers && s.speakers.length) || 0}</td>
                <td>{hasGeo ? <Icon name="pin" size={15} className="cell-geo-on" /> : <span className="muted">—</span>}</td>
                <td className="cell-actions" onClick={(e) => e.stopPropagation()}>
                  <span className="row-actions">
                    <IconButton icon="edit" size="sm" label="Editar" onClick={() => edit(s)} />
                    <IconButton icon="trash" size="sm" label="Eliminar" onClick={(e) => del(e, s)} />
                  </span>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </CollectionView>
  )
}
