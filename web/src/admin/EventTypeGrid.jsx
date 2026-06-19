// EventTypeGrid — selector visual de tipos de evento: tarjetas cuadradas con
// icono grande + nombre + descripción, tipo botón. Reutilizable (alertas, reglas,
// wizard). Explica cada tipo de un vistazo.
import { Icon } from '../ui/primitives.jsx'
import { EVENT_TYPE_LABELS, EVENT_TYPE_ICON } from '../lib/labels.js'

export const EVENT_TYPE_DESC = {
  line_crossing: 'Cruza una línea virtual',
  intrusion: 'Entra a una zona prohibida',
  region_entrance: 'Entra a una zona definida',
  region_exit: 'Sale de una zona definida',
  motion: 'Movimiento detectado',
  face: 'Rostro detectado',
  lpr: 'Lee una matrícula',
  tamper: 'Cámara tapada o movida',
  video_loss: 'Se perdió la señal',
  doorbell: 'Llamada de portero',
  door_forced: 'Puerta abierta a la fuerza',
  door_held: 'Puerta mantenida abierta',
  access_denied: 'Acceso rechazado',
  alarm: 'Botón de pánico / alarma',
  tamper_alarm: 'Sabotaje de la central',
  system: 'Evento del sistema',
}

export function EventTypeGrid({ types = [], isOn, onToggle, size = 'md' }) {
  return (
    <div className={`etgrid etgrid--${size}`}>
      {types.map((val) => {
        const on = !!(isOn && isOn(val))
        return (
          <button type="button" key={val} className={`etcard${on ? ' is-on' : ''}`} aria-pressed={on}
            onClick={() => onToggle && onToggle(val)}>
            <span className="etcard__ic"><Icon name={EVENT_TYPE_ICON[val] || 'bolt'} size={22} /></span>
            <span className="etcard__lbl">{EVENT_TYPE_LABELS[val] || val}</span>
            {EVENT_TYPE_DESC[val] && <span className="etcard__desc">{EVENT_TYPE_DESC[val]}</span>}
            {on && <span className="etcard__check" aria-hidden="true"><Icon name="check" size={13} /></span>}
          </button>
        )
      })}
    </div>
  )
}

export default EventTypeGrid
