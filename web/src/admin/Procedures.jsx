// Procedimientos — listado. La edición es una página dedicada (ProcedureEdit).
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { IconButton, Badge, Icon } from '../ui/primitives.jsx'
import { useAdminData } from '../lib/adminApi.js'
import { CollectionView, useToast, confirmDelete } from './_shared.jsx'

export default function Procedures() {
  const { items, loading, error, reload, remove } = useAdminData('procedures')
  const toast = useToast()
  const navigate = useNavigate()
  const [q, setQ] = useState('')

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase()
    if (!term) return items
    return items.filter((p) =>
      [p.name, ...(p.steps || [])].filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(term)))
  }, [items, q])

  const edit = (p) => navigate(`/admin/procedures/${p.id}`)
  const del = async (e, p) => {
    e.stopPropagation()
    if (!confirmDelete(p.name)) return
    try { await remove(p.id); toast('Procedimiento eliminado') } catch (err) { toast(err.message, 'error') }
  }

  return (
    <CollectionView
      title="Procedimientos" subtitle="Protocolos paso a paso que se muestran al operario al atender un evento."
      help={{ id: 'procedures', icon: 'procedure', title: 'Procedimientos (SOP)',
        text: 'Protocolos paso a paso que se le muestran al operario al atender un evento, según la regla que casó. Escribí pasos claros y accionables: verificar el video, llamar al contacto del sitio, dar aviso a la policía. Un buen SOP acelera la respuesta y reduce errores.' }}
      newLabel="Nuevo procedimiento" onNew={() => navigate('/admin/procedures/new')}
      search={{ value: q, onChange: setQ, placeholder: 'Buscar por nombre o paso…' }}
      loading={loading} error={error} onRetry={reload} loadingCols={4}
      isEmpty={items.length === 0}
      empty={{ icon: 'procedure', title: 'Sin procedimientos', children: 'Define protocolos para guiar al operario.' }}
      isNoResults={items.length > 0 && filtered.length === 0}
    >
      <table className="adm-table">
        <thead><tr>
          <th><span className="th-ic"><Icon name="procedure" size={13} />Nombre</span></th>
          <th><span className="th-ic"><Icon name="clock" size={13} />SLA</span></th>
          <th><span className="th-ic"><Icon name="rules" size={13} />Pasos</span></th>
          <th />
        </tr></thead>
        <tbody className="stagger">
          {filtered.map((p) => (
            <tr key={p.id} className="adm-row--click" onClick={() => edit(p)}>
              <td className="cell-name">{p.name}</td>
              <td className="cell-mono">{p.slaSeconds}s</td>
              <td><Badge tone="neutral">{p.steps?.length || 0} pasos</Badge></td>
              <td className="cell-actions" onClick={(e) => e.stopPropagation()}>
                <span className="row-actions">
                  <IconButton icon="edit" size="sm" label="Editar" onClick={() => edit(p)} />
                  <IconButton icon="trash" size="sm" label="Eliminar" onClick={(e) => del(e, p)} />
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </CollectionView>
  )
}
