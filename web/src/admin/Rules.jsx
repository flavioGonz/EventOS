// Reglas — listado. La edición es una página dedicada (RuleEdit), no un modal.
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { IconButton, Switch, Badge, PriorityDot, Icon } from '../ui/primitives.jsx'
import { useAdminData, collectionApi, unwrap } from '../lib/adminApi.js'
import {
  eventTypeLabel, categoryLabel, dispatchModeLabel, priorityLabel, EVENT_TYPE_ICON,
} from '../lib/labels.js'
import { CollectionView, useToast, confirmDelete } from './_shared.jsx'

const ruleModeLabel = (m) => (m === 'rules-inherit' ? dispatchModeLabel('inherit') : dispatchModeLabel(m))

export default function Rules() {
  const { items, loading, error, reload, update, remove } = useAdminData('rules')
  const toast = useToast()
  const navigate = useNavigate()
  const [procedures, setProcedures] = useState([])
  const [q, setQ] = useState('')

  useEffect(() => {
    collectionApi('procedures').list().then((d) => setProcedures(unwrap(d, 'procedures'))).catch(() => {})
  }, [])
  const procName = useMemo(() => Object.fromEntries(procedures.map((p) => [p.id, p.name])), [procedures])

  const sorted = useMemo(() => [...items].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)), [items])
  const visible = useMemo(() => {
    const term = q.trim().toLowerCase()
    if (!term) return sorted
    return sorted.filter((r) =>
      [r.name, ...(r.match?.type || []).map(eventTypeLabel), ...(r.match?.category || []).map(categoryLabel)]
        .filter(Boolean).some((v) => String(v).toLowerCase().includes(term)))
  }, [sorted, q])

  const edit = (r) => navigate(`/admin/rules/${r.id}`)
  const del = async (e, r) => {
    e.stopPropagation()
    if (!confirmDelete(r.name)) return
    try { await remove(r.id); toast('Regla eliminada') } catch (err) { toast(err.message, 'error') }
  }
  const toggleEnabled = async (r) => {
    try { await update(r.id, { ...r, enabled: !r.enabled }) } catch (e) { toast(e.message, 'error') }
  }

  return (
    <CollectionView
      title="Reglas" subtitle="Casan eventos entrantes y aplican prioridad, procedimiento y enrutado. Se evalúan por orden ascendente."
      help={{ id: 'rules', icon: 'rules', title: 'Cómo funcionan las reglas',
        text: 'Cada evento entrante se compara con las reglas en orden ascendente; la primera que casa define su prioridad, el procedimiento que verá el operario y a quién se despacha. Usá la coincidencia por tipo y por objetivo (persona / vehículo) para filtrar falsas alarmas y enviar lo importante al grupo correcto.' }}
      newLabel="Nueva regla" onNew={() => navigate('/admin/rules/new')}
      search={{ value: q, onChange: setQ, placeholder: 'Buscar por nombre, tipo o categoría…' }}
      loading={loading} error={error} onRetry={reload} loadingCols={8}
      isEmpty={items.length === 0}
      empty={{ icon: 'rules', title: 'Sin reglas', children: 'Crea reglas para clasificar y enrutar eventos.' }}
      isNoResults={items.length > 0 && visible.length === 0}
    >
      <table className="adm-table">
        <thead><tr>
          <th><span className="th-ic"><Icon name="hash" size={13} />Orden</span></th>
          <th><span className="th-ic"><Icon name="rules" size={13} />Nombre</span></th>
          <th><span className="th-ic"><Icon name="filter" size={13} />Casa</span></th>
          <th><span className="th-ic"><Icon name="flag" size={13} />Prioridad</span></th>
          <th><span className="th-ic"><Icon name="procedure" size={13} />Procedimiento</span></th>
          <th><span className="th-ic"><Icon name="balance" size={13} />Modo</span></th>
          <th><span className="th-ic"><Icon name="online" size={13} />Activa</span></th>
          <th />
        </tr></thead>
        <tbody className="stagger">
          {visible.map((r) => (
            <tr key={r.id} className={`adm-row--click${r.enabled ? '' : ' is-row-off'}`} onClick={() => edit(r)}>
              <td className="cell-mono">{r.order}</td>
              <td className="cell-name">{r.name}</td>
              <td>
                <span className="inline-tags">
                  {(r.match?.type || []).slice(0, 3).map((t) => (
                    <Badge key={t} tone="neutral"><Icon name={EVENT_TYPE_ICON[t] || 'dot'} size={12} />{eventTypeLabel(t)}</Badge>
                  ))}
                  {(r.match?.type?.length || 0) > 3 && <Badge tone="neutral">+{r.match.type.length - 3}</Badge>}
                  {!(r.match?.type?.length) && (r.match?.category?.length)
                    ? r.match.category.map((c) => <Badge key={c} tone="accent">{categoryLabel(c)}</Badge>) : null}
                  {!(r.match?.type?.length) && !(r.match?.category?.length) && <span className="muted">cualquiera</span>}
                </span>
              </td>
              <td>{r.actions?.setPriority ? <span className="kv"><PriorityDot p={r.actions.setPriority} /> {`P${r.actions.setPriority} · ${priorityLabel(r.actions.setPriority)}`}</span> : <span className="muted">—</span>}</td>
              <td className="cell-dim">{procName[r.actions?.procedureId] || <span className="muted">—</span>}</td>
              <td>{r.actions?.dispatchMode ? <Badge tone="accent">{ruleModeLabel(r.actions.dispatchMode)}</Badge> : <span className="muted">—</span>}</td>
              <td onClick={(e) => e.stopPropagation()}><Switch checked={r.enabled} onChange={() => toggleEnabled(r)} aria-label={`Activar ${r.name}`} /></td>
              <td className="cell-actions" onClick={(e) => e.stopPropagation()}>
                <span className="row-actions">
                  <IconButton icon="edit" size="sm" label="Editar" onClick={() => edit(r)} />
                  <IconButton icon="trash" size="sm" label="Eliminar" onClick={(e) => del(e, r)} />
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </CollectionView>
  )
}
