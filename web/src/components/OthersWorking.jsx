// OthersWorking.jsx — indicadores flotantes (columna vertical derecha) de las
// alertas que están trabajando OTROS operarios. Da visibilidad en vivo a todos:
// avatar del operario + cliente + tipo. Se arma de events (assignedTo) + operators.
import { useMemo } from 'react'
import { Icon } from '../ui/primitives.jsx'

const TYPE_LABEL = {
  access_granted: 'Acceso', access_denied: 'Acceso denegado', alarm: 'Alarma',
  tamper_alarm: 'Sabotaje', door_held: 'Puerta abierta', door_forced: 'Puerta forzada',
  doorbell: 'Portero', motion: 'Movimiento', line_crossing: 'Cruce de línea',
  intrusion: 'Intrusión', region_entrance: 'Entrada a zona', region_exit: 'Salida de zona',
  loitering: 'Merodeo', face: 'Rostro', lpr: 'Patente', comm_fail: 'Sin comunicación',
}
const DONE = ['resolved', 'discarded', 'closed', 'new']

function initials(name = '') {
  return name.trim().split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase() || '·'
}
function clientOf(e) {
  const src = e.source || {}
  return src.site || src.siteName || e.siteName || src.deviceName || '—'
}
function labelOf(e) {
  return e.title || TYPE_LABEL[e.type] || e.type || 'Evento'
}

function Av({ op }) {
  if (op && op.avatarUrl) return <img className="others__img" src={op.avatarUrl} alt="" />
  return <span className="others__ini">{initials(op && op.name)}</span>
}

export default function OthersWorking({ events = [], operators = [], me }) {
  const meId = me && (me.operatorId || me.id)
  const opById = useMemo(() => {
    const m = {}
    for (const o of operators) m[o.operatorId || o.id] = o
    return m
  }, [operators])

  const items = useMemo(() =>
    (events || [])
      .filter((e) => e.assignedTo && e.assignedTo !== meId && !DONE.includes(e.status))
      .sort((a, b) => (a.priority ?? 5) - (b.priority ?? 5))
      .slice(0, 12)
      .map((e) => ({ e, op: opById[e.assignedTo] })),
  [events, opById, meId])

  if (!items.length) return null

  return (
    <div className="others" aria-label="Alertas en trabajo por otros operarios">
      <div className="others__hd"><Icon name="users" size={12} /> En trabajo</div>
      {items.map(({ e, op }) => (
        <div key={e.id} className={`others__it prio-${e.priority ?? 5}`}
             title={`${(op && op.name) || 'Operario'} · ${clientOf(e)} · ${labelOf(e)}`}>
          <span className="others__av"><Av op={op} /></span>
          <div className="others__meta">
            <span className="others__op">{(op && op.name) || '—'}</span>
            <span className="others__cli">{clientOf(e)} · {labelOf(e)}</span>
          </div>
        </div>
      ))}
    </div>
  )
}
