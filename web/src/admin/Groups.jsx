// Grupos de operarios — listado. La edición es una página dedicada (GroupEdit).
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { IconButton, Badge, Icon } from '../ui/primitives.jsx'
import { useAdminData, collectionApi, unwrap } from '../lib/adminApi.js'
import { categoryLabel } from '../lib/labels.js'
import { CollectionView, useToast, confirmDelete } from './_shared.jsx'

export default function Groups() {
  const { items, loading, error, reload, remove } = useAdminData('groups')
  const toast = useToast()
  const navigate = useNavigate()
  const [operators, setOperators] = useState([])
  const [q, setQ] = useState('')

  useEffect(() => {
    collectionApi('operators').list().then((d) => setOperators(unwrap(d, 'operators'))).catch(() => {})
  }, [])
  const opName = useMemo(() => Object.fromEntries(operators.map((o) => [o.id, o.name])), [operators])

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase()
    if (!term) return items
    return items.filter((g) => String(g.name || '').toLowerCase().includes(term))
  }, [items, q])

  const edit = (g) => navigate(`/admin/groups/${g.id}`)
  const del = async (e, g) => {
    e.stopPropagation()
    if (!confirmDelete(g.name)) return
    try { await remove(g.id); toast('Grupo eliminado') } catch (err) { toast(err.message, 'error') }
  }

  return (
    <CollectionView
      title="Grupos" subtitle="Conjuntos de operarios para enrutar reglas y transferir eventos en vivo."
      help={{ id: 'groups', icon: 'shieldcheck', title: 'Grupos de operarios',
        text: 'Conjuntos de operarios. Una regla puede despachar a un grupo entero, y el operador puede transferir un evento en vivo a un grupo. Útil para organizar por turnos o por especialidad (p. ej. «Intrusiones» o «Video»).' }}
      newLabel="Nuevo grupo" onNew={() => navigate('/admin/groups/new')}
      search={{ value: q, onChange: setQ, placeholder: 'Buscar grupo…' }}
      loading={loading} error={error} onRetry={reload} loadingCols={4}
      isEmpty={items.length === 0}
      empty={{ icon: 'users', title: 'Sin grupos', children: 'Crea un grupo para enrutar eventos a varios operarios.' }}
      isNoResults={items.length > 0 && filtered.length === 0}
    >
      <table className="adm-table">
        <thead><tr>
          <th><span className="th-ic"><Icon name="users" size={13} />Grupo</span></th>
          <th><span className="th-ic"><Icon name="users" size={13} />Miembros</span></th>
          <th><span className="th-ic"><Icon name="tag" size={13} />Competencias</span></th>
          <th />
        </tr></thead>
        <tbody className="stagger">
          {filtered.map((g) => (
            <tr key={g.id} className="adm-row--click" onClick={() => edit(g)}>
              <td className="cell-name">{g.name}</td>
              <td>
                {g.operatorIds?.length
                  ? <span className="inline-tags">
                      {g.operatorIds.slice(0, 4).map((id) => <Badge key={id} tone="neutral">{opName[id] || id}</Badge>)}
                      {g.operatorIds.length > 4 && <Badge tone="neutral">+{g.operatorIds.length - 4}</Badge>}
                    </span>
                  : <span className="muted">—</span>}
              </td>
              <td>
                {g.skills?.length
                  ? <span className="inline-tags">{g.skills.map((s) => <Badge key={s} tone="accent">{categoryLabel(s)}</Badge>)}</span>
                  : <span className="muted">cualquiera</span>}
              </td>
              <td className="cell-actions" onClick={(e) => e.stopPropagation()}>
                <span className="row-actions">
                  <IconButton icon="edit" size="sm" label="Editar" onClick={() => edit(g)} />
                  <IconButton icon="trash" size="sm" label="Eliminar" onClick={(e) => del(e, g)} />
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </CollectionView>
  )
}
