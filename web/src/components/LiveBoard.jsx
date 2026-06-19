import { useEffect, useMemo, useRef, useState } from 'react'
import { Badge, EmptyState, Icon, Segmented } from '../ui/primitives.jsx'
import { eventTypeLabel, EVENT_TYPE_ICON, TARGET_ICON, targetLabel } from '../lib/labels.js'
import {
  STATUS_LABEL,
  priorityClass,
  slaInfo,
  sourceLine,
  timeAgo,
} from '../lib/format.js'

// Tablero principal de eventos en vivo — KANBAN por CRITICIDAD.
// Una columna por prioridad (P1 Crítico … P5 Info); dentro de cada columna los
// eventos se AGRUPAN por tipo (con icono + conteo). Click abre el EventPopup.
// Los críticos sin asignar reciben un aro de atención (pulse-ring).

const FILTERS = [
  { value: 'active', label: 'Activos' },
  { value: 'all', label: 'Todos' },
  { value: 'mine', label: 'Míos' },
]

// Columnas de criticidad (de más a menos crítico).
const PRIO_COLS = [
  { p: 1, label: 'Crítico' },
  { p: 2, label: 'Alto' },
  { p: 3, label: 'Medio' },
  { p: 4, label: 'Bajo' },
  { p: 5, label: 'Info' },
]

const STATUS_TONE = {
  new: 'accent',
  assigned: 'accent',
  ack: 'warn',
  in_progress: 'warn',
  resolved: 'ok',
  escalated: 'crit',
}

export default function LiveBoard({ events, operator, onOpen }) {
  const [filter, setFilter] = useState('active')

  // Recalcular "time-ago" cada 10s sin tocar la fuente de datos.
  const [, setTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 10000)
    return () => clearInterval(t)
  }, [])

  const filtered = useMemo(() => {
    const opId = operator && operator.operatorId
    return events.filter((e) => {
      const active = e.status !== 'resolved' && e.status !== 'escalated'
      if (filter === 'active') return active
      if (filter === 'mine') return e.assignedTo && e.assignedTo === opId
      return true
    })
  }, [events, filter, operator])

  // Reparte en columnas por prioridad y, dentro, agrupa por tipo (orden: grupo
  // con el evento más reciente primero; dentro del grupo, por recencia desc).
  const columns = useMemo(() => {
    const byPrio = new Map(PRIO_COLS.map((c) => [c.p, []]))
    for (const e of filtered) {
      const p = Math.min(5, Math.max(1, e.priority ?? 5))
      byPrio.get(p).push(e)
    }
    return PRIO_COLS.map((col) => {
      const list = byPrio.get(col.p) || []
      const groupMap = new Map()
      for (const e of list) {
        const t = e.type || 'system'
        if (!groupMap.has(t)) groupMap.set(t, [])
        groupMap.get(t).push(e)
      }
      const groups = [...groupMap.entries()].map(([type, evs]) => {
        evs.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime())
        return { type, events: evs, latest: new Date(evs[0].ts).getTime() }
      })
      groups.sort((a, b) => b.latest - a.latest)
      return { ...col, count: list.length, groups }
    })
  }, [filtered])

  return (
    <section className="board glass">
      <header className="board__head">
        <div className="board__titles">
          <h2 className="board__title">Eventos en vivo</h2>
          <span className="board__count tnum">{filtered.length} eventos</span>
        </div>
        <Segmented value={filter} onChange={setFilter} options={FILTERS} />
      </header>

      {filtered.length === 0 ? (
        <EmptyState icon="bell" title="Sin eventos">
          Usa el simulador para generar tráfico de demo.
        </EmptyState>
      ) : (
        <div className="board__cols">
          {columns.map((col) => (
            <div key={col.p} className="board__col" style={{ '--accent-prio': `var(--p${col.p})` }}>
              <div className="board__col-head">
                <span className="board__col-dot" aria-hidden="true" />
                <span className="board__col-label">P{col.p} · {col.label}</span>
                <span className="board__col-count tnum">{col.count}</span>
              </div>
              <div className="board__col-body">
                {col.groups.length === 0 ? (
                  <p className="board__col-empty">—</p>
                ) : (
                  col.groups.map((g) => (
                    <div key={g.type} className="evgroup">
                      <div className="evgroup__head">
                        <Icon name={EVENT_TYPE_ICON[g.type] || 'dot'} size={13} />
                        <span className="evgroup__name">{eventTypeLabel(g.type)}</span>
                        <span className="evgroup__count tnum">{g.events.length}</span>
                      </div>
                      <div className="evgroup__cards">
                        {g.events.map((e) => (
                          <EventCard key={e.id} event={e} operator={operator} onOpen={onOpen} />
                        ))}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

// Miniatura del evento: la foto del momento (evidencia capturada) o, si no hay,
// un icono del tipo sobre un fondo tramado. El foco del board es el EVENTO que
// llega, así que su imagen va al frente.
function EvCardThumb({ event }) {
  const [fail, setFail] = useState(false)
  const m = event.media || {}
  const src = m.evidenceUrl || m.snapshotUrl || null
  const icon = EVENT_TYPE_ICON[event.type] || 'camera'
  return (
    <span className="evcard__thumb" aria-hidden="true">
      {src && !fail
        ? <img className="evcard__thumb-img" src={src} alt="" loading="lazy" onError={() => setFail(true)} />
        : <span className="evcard__thumb-ph"><Icon name={icon} size={18} /></span>}
    </span>
  )
}

function EventCard({ event, operator, onOpen }) {
  const isNew = useRef(true)
  useEffect(() => {
    const t = setTimeout(() => { isNew.current = false }, 1600)
    return () => clearTimeout(t)
  }, [])

  const pc = priorityClass(event.priority)
  const p = event.priority ?? 5
  const critical = p <= 1
  const attention = critical && event.status === 'new' && !event.assignedTo
  const mine = event.assignedTo && operator && event.assignedTo === operator.operatorId
  const sla = slaInfo(event)

  const cls = ['evcard', isNew.current ? 'anim-pop' : '', attention ? 'evcard--attn' : '', mine ? 'evcard--mine' : '']
    .filter(Boolean).join(' ')

  return (
    <button
      type="button"
      className={cls}
      style={{ '--accent-prio': `var(--${pc})` }}
      onClick={() => onOpen(event)}
    >
      <span className="evcard__rail" aria-hidden="true" />
      {attention && <span className="evcard__ring" aria-hidden="true" />}
      <EvCardThumb event={event} />
      <span className="evcard__body">
        <div className="evcard__top">
          <h4 className="evcard__title">{event.title || event.type}</h4>
          {event.target && event.target !== 'none' && (
            <Icon name={TARGET_ICON[event.target] || 'dot'} size={13}
                  className={`evcard__target evcard__target--${event.target}`}
                  title={`Objetivo: ${targetLabel(event.target)}`} />
          )}
          <span className="evcard__time tnum">{timeAgo(event.ts)}</span>
        </div>
        <p className="evcard__source">{sourceLine(event)}</p>
        <div className="evcard__foot">
          <Badge tone={STATUS_TONE[event.status] || 'neutral'}>
            {STATUS_LABEL[event.status] || event.status}
          </Badge>
          {sla && <span className={`evcard__sla evcard__sla--${sla.tone}`}>{sla.label}</span>}
          <span className="evcard__assignee">
            {event.assignedTo ? (mine ? 'Tú' : assigneeName(event)) : 'Sin asignar'}
          </span>
        </div>
      </span>
    </button>
  )
}

function assigneeName(event) {
  const log = Array.isArray(event.log) ? event.log : []
  for (let i = log.length - 1; i >= 0; i--) {
    const l = log[i]
    if (l.operatorId === event.assignedTo && l.operatorName) return l.operatorName
  }
  return event.assignedTo
}
