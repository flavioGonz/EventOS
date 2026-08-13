// EventTypeGrid — selector visual de tipos de evento. Dos modos:
//  · layout="cards" (por defecto): tarjetas cuadradas con icono grande.
//  · layout="table": filas seleccionables, discretas, con icono + nombre +
//    descripción + estado, y tooltip explicativo por fila.
// Reutilizable (alertas, reglas, wizard). Explica cada tipo de un vistazo.
import { Icon, Tooltip } from '../ui/primitives.jsx'
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

// Explicación extensa por tipo → tooltip de cada fila/tarjeta.
export const EVENT_TYPE_TOOLTIP = {
  line_crossing: 'Se dispara cuando un objetivo cruza una línea virtual dibujada en la cámara, en el sentido configurado. Ideal para perímetros. Ej.: alguien salta un cerco de noche.',
  intrusion: 'Permanencia dentro de una zona prohibida más de N segundos. A diferencia del cruce, importa quedarse, no pasar. Ej.: alguien entra al patio y se queda.',
  region_entrance: 'Cuando un objetivo ENTRA a una región definida. Ej.: acceso a un depósito restringido.',
  region_exit: 'Cuando un objetivo SALE de una región definida. Ej.: sustracción de mercadería de un área.',
  motion: 'Detección básica de movimiento por píxeles. Muy sensible (ramas, sombras, lluvia); conviene usar el filtro por objetivo para reducir falsas alarmas.',
  face: 'La cámara detecta o identifica un rostro. Requiere modelo con reconocimiento facial.',
  lpr: 'Lee patentes de vehículos (ANPR/LPR). Requiere cámara con lectura de matrículas.',
  tamper: 'La cámara fue tapada, girada o desenfocada: señal de manipulación del equipo.',
  video_loss: 'Se cortó la señal de la cámara (cable, energía o falla). Es un problema de salud crítico: sin video no hay grabación.',
  doorbell: 'Alguien llamó desde el portero / intercomunicador.',
  door_forced: 'Se abrió una puerta sin autorización, a la fuerza.',
  door_held: 'Una puerta quedó abierta más del tiempo permitido.',
  access_denied: 'Se rechazó una credencial (tarjeta, PIN o rostro no válido).',
  alarm: 'Disparo de botón de pánico o de una zona de alarma de la central.',
  tamper_alarm: 'Manipulación o sabotaje del panel de alarma.',
  system: 'Eventos del propio equipo: arranque, reinicio, cambios de estado.',
}

// `status(val)` (opcional) → { label, tone } para una etiqueta de estado
// (p. ej. marcar qué analíticas están realmente dibujadas en la cámara).
// `tooltip(val)` (opcional) → nodo con la explicación; por defecto usa el mapa.
export function EventTypeGrid({ types = [], isOn, onToggle, size = 'md', status = null, layout = 'cards', tooltip }) {
  const tipFor = (val) => (tooltip ? tooltip(val) : EVENT_TYPE_TOOLTIP[val]) || null

  if (layout === 'table') {
    return (
      <div className="etable" role="listbox" aria-multiselectable="true">
        {types.map((val) => {
          const on = !!(isOn && isOn(val))
          const st = status ? status(val) : null
          const tip = tipFor(val)
          const row = (
            <button type="button" className={`etrow${on ? ' is-on' : ''}`} role="option" aria-selected={on}
              onClick={() => onToggle && onToggle(val)}>
              <span className="etrow__chk" aria-hidden="true">{on ? <Icon name="check" size={13} /> : null}</span>
              <span className="etrow__ic"><Icon name={EVENT_TYPE_ICON[val] || 'bolt'} size={16} /></span>
              <span className="etrow__lbl">{EVENT_TYPE_LABELS[val] || val}</span>
              <span className="etrow__desc">{EVENT_TYPE_DESC[val] || ''}</span>
              {st && <span className={`etrow__tag t-${st.tone}`}>{st.tone === 'ok' ? '● ' : '○ '}{st.label}</span>}
            </button>
          )
          return tip
            ? <Tooltip key={val} content={tip} side="left" className="etrow-tt">{row}</Tooltip>
            : <span key={val} className="etrow-tt">{row}</span>
        })}
      </div>
    )
  }

  return (
    <div className={`etgrid etgrid--${size}`}>
      {types.map((val) => {
        const on = !!(isOn && isOn(val))
        const st = status ? status(val) : null
        return (
          <button type="button" key={val} className={`etcard${on ? ' is-on' : ''}`} aria-pressed={on}
            onClick={() => onToggle && onToggle(val)}>
            <span className="etcard__ic"><Icon name={EVENT_TYPE_ICON[val] || 'bolt'} size={22} /></span>
            <span className="etcard__lbl">{EVENT_TYPE_LABELS[val] || val}</span>
            {EVENT_TYPE_DESC[val] && <span className="etcard__desc">{EVENT_TYPE_DESC[val]}</span>}
            {st && <span className={`etcard__tag etcard__tag--${st.tone}`}>{st.tone === 'ok' ? '● ' : '○ '}{st.label}</span>}
            {on && <span className="etcard__check" aria-hidden="true"><Icon name="check" size={13} /></span>}
          </button>
        )
      })}
    </div>
  )
}

export default EventTypeGrid
