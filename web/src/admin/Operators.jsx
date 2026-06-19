// Operarios — listado + panel EN VIVO (estado/pausa, carga, atendidos). La edición
// es una página dedicada (OperatorEdit), no un modal.
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { IconButton, Switch, Badge, Icon, StatusDot } from '../ui/primitives.jsx'
import { useAdminData, api } from '../lib/adminApi.js'
import { categoryLabel, operatorStatusLabel, pauseReasonLabel } from '../lib/labels.js'
import { CollectionView, useToast, confirmDelete } from './_shared.jsx'

// ms → "1h 23m" o "MM:SS".
function fmtDuration(ms) {
  const s = Math.max(0, Math.floor((ms || 0) / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
}

function useOperatorStats(intervalMs = 10000) {
  const [byId, setById] = useState({})
  const alive = useRef(true)
  const poll = useCallback(async () => {
    try {
      const data = await api.get('/operators/stats')
      const list = Array.isArray(data) ? data
        : Array.isArray(data?.operators) ? data.operators
        : Array.isArray(data?.items) ? data.items : []
      const map = {}
      for (const s of list) { const id = s.id ?? s.operatorId; if (id != null) map[id] = s }
      if (alive.current) setById(map)
    } catch { /* endpoint puede no existir aún */ }
  }, [])
  useEffect(() => {
    alive.current = true
    poll()
    const t = setInterval(poll, intervalMs)
    return () => { alive.current = false; clearInterval(t) }
  }, [poll, intervalMs])
  return byId
}

export default function Operators() {
  const { items, loading, error, reload, update, remove } = useAdminData('operators')
  const stats = useOperatorStats(10000)
  const toast = useToast()
  const navigate = useNavigate()
  const [q, setQ] = useState('')

  const edit = (op) => navigate(`/admin/operators/${op.id}`)
  const del = async (e, op) => {
    e.stopPropagation()
    if (!confirmDelete(op.name)) return
    try { await remove(op.id); toast('Operario eliminado') } catch (err) { toast(err.message, 'error') }
  }
  const toggleActive = async (op) => {
    try { await update(op.id, { ...op, active: !op.active }) } catch (e) { toast(e.message, 'error') }
  }

  const rows = items.map((op) => ({ ...op, live: stats[op.id] || null }))
  const liveRows = rows.filter((r) => r.live)
  const nAvailable = liveRows.filter((r) => (r.live.status || (r.live.online ? 'available' : 'offline')) === 'available').length
  const nPaused = liveRows.filter((r) => r.live.status === 'paused').length
  const nOnline = liveRows.filter((r) => r.live.online).length

  const term = q.trim().toLowerCase()
  const filteredRows = !term ? rows : rows.filter((op) =>
    [op.name, ...(op.skills || []).map(categoryLabel)].filter(Boolean)
      .some((v) => String(v).toLowerCase().includes(term)))

  const summary = liveRows.length > 0 ? (
    <div className="op-summary">
      <span className="op-summary__chip"><StatusDot tone="ok" /><strong className="tnum">{nAvailable}</strong> disponibles</span>
      <span className="op-summary__chip"><StatusDot tone="warn" /><strong className="tnum">{nPaused}</strong> en pausa</span>
      <span className="op-summary__chip"><Icon name="online" size={13} /><strong className="tnum">{nOnline}</strong> en línea</span>
    </div>
  ) : null

  return (
    <CollectionView
      title="Operarios" subtitle="Listado de operadores y sus competencias para el enrutado por competencia."
      help={{ id: 'operators', icon: 'users', title: 'Operarios',
        text: 'Las personas que atienden los eventos. Sus competencias (skills) permiten enrutar cada tipo de evento al operario adecuado. El estado (disponible / en pausa) y la carga de trabajo se ven en tiempo real en el panel de Supervisor.' }}
      newLabel="Nuevo operario" onNew={() => navigate('/admin/operators/new')}
      beforeCard={summary}
      search={{ value: q, onChange: setQ, placeholder: 'Buscar por nombre o competencia…' }}
      loading={loading} error={error} onRetry={reload} loadingCols={9}
      isEmpty={items.length === 0}
      empty={{ icon: 'users', title: 'Sin operarios', children: 'Añade operarios para poder asignarles eventos.' }}
      isNoResults={items.length > 0 && filteredRows.length === 0}
    >
      <table className="adm-table">
        <thead><tr>
          <th><span className="th-ic"><Icon name="users" size={13} />Nombre</span></th>
          <th><span className="th-ic"><Icon name="online" size={13} />Estado</span></th>
          <th><span className="th-ic"><Icon name="gauge" size={13} />Carga</span></th>
          <th><span className="th-ic"><Icon name="check" size={13} />Atendidos</span></th>
          <th><span className="th-ic"><Icon name="clock" size={13} />Disponible</span></th>
          <th><span className="th-ic"><Icon name="pause" size={13} />En pausa</span></th>
          <th><span className="th-ic"><Icon name="tag" size={13} />Competencias</span></th>
          <th><span className="th-ic"><Icon name="online" size={13} />Activo</span></th>
          <th />
        </tr></thead>
        <tbody className="stagger">
          {filteredRows.map((op) => {
            const live = op.live
            const st = live ? (live.status || (live.online ? 'available' : 'offline')) : null
            const tone = st === 'available' ? 'ok' : st === 'paused' ? 'warn' : 'neutral'
            return (
              <tr key={op.id} className="adm-row--click" onClick={() => edit(op)}>
                <td className="cell-name">{op.name}</td>
                <td>
                  {st ? (
                    <Badge tone={tone}>
                      {st === 'paused' && live.pauseReason
                        ? `En pausa · ${pauseReasonLabel(live.pauseReason)}`
                        : operatorStatusLabel(st)}
                    </Badge>
                  ) : <span className="muted">—</span>}
                </td>
                <td className="cell-mono">{live ? (live.load ?? 0) : <span className="muted">—</span>}</td>
                <td className="cell-mono">{live ? (live.handled ?? 0) : <span className="muted">—</span>}</td>
                <td className="cell-mono">{live ? fmtDuration(live.msAvailable) : <span className="muted">—</span>}</td>
                <td className="cell-mono">{live ? fmtDuration(live.msPaused) : <span className="muted">—</span>}</td>
                <td>
                  {op.skills?.length
                    ? <span className="inline-tags">{op.skills.map((s) => <Badge key={s} tone="neutral">{categoryLabel(s)}</Badge>)}</span>
                    : <span className="muted">—</span>}
                </td>
                <td onClick={(e) => e.stopPropagation()}><Switch checked={op.active} onChange={() => toggleActive(op)} aria-label={`Activar ${op.name}`} /></td>
                <td className="cell-actions" onClick={(e) => e.stopPropagation()}>
                  <span className="row-actions">
                    <IconButton icon="edit" size="sm" label="Editar" onClick={() => edit(op)} />
                    <IconButton icon="trash" size="sm" label="Eliminar" onClick={(e) => del(e, op)} />
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
