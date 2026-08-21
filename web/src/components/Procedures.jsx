import { useEffect, useState } from 'react'
import { Badge, Icon } from '../ui/primitives.jsx'

// Checklist reutilizable del procedimiento, usado dentro del EventPopup.
// Renderiza los pasos con casillas estilo iOS y lleva el avance localmente. Al
// marcar un paso emite una nota a la bitácora (event:note) vía onStepNote.
// NOTA: la disposición + botón "Resolver" se movieron al grupo "Gestión del
// evento" del popup; acá queda solo el checklist.

export default function Procedures({ procedure, eventId, onStepNote }) {
  const steps = (procedure && procedure.steps) || []

  const [checked, setChecked] = useState(() => steps.map(() => false))

  // Reiniciar el avance cuando cambia el evento/procedimiento.
  useEffect(() => {
    setChecked(steps.map(() => false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId, procedure && procedure.id])

  const done = checked.filter(Boolean).length
  const total = steps.length || 1
  const pct = Math.round((done / total) * 100)

  function toggle(i) {
    setChecked((prev) => {
      const next = prev.slice()
      next[i] = !next[i]
      // Al completar un paso, registrar en bitácora.
      if (next[i] && onStepNote) {
        onStepNote(`Paso completado: ${steps[i]}`)
      }
      return next
    })
  }

  return (
    <div className="proc">
      <div className="proc__head">
        <h4 className="proc__name">
          <Icon name="procedure" size={15} />
          Procedimiento{procedure && procedure.name ? ` · ${procedure.name}` : ''}
        </h4>
        {procedure && procedure.slaSeconds ? (
          <Badge tone="neutral">SLA {procedure.slaSeconds}s</Badge>
        ) : null}
      </div>

      <div className="proc__progress">
        <div className="proc__progress-track" aria-label={`Avance ${pct}%`}>
          <div className="proc__progress-bar" style={{ width: `${pct}%` }} />
        </div>
        <span className="proc__progress-text tnum">
          {done}/{steps.length} pasos
        </span>
      </div>

      <ol className="proc__steps">
        {steps.map((step, i) => (
          <li key={i} className={`proc__step ${checked[i] ? 'is-done' : ''}`}>
            <button
              type="button"
              className="proc__step-btn"
              role="checkbox"
              aria-checked={checked[i]}
              onClick={() => toggle(i)}
            >
              <span className="proc__check" aria-hidden="true">
                <Icon name="check" size={13} />
              </span>
              <span className="proc__step-text">{step}</span>
            </button>
          </li>
        ))}
        {steps.length === 0 ? (
          <li className="proc__step proc__step--empty">Sin procedimiento asociado.</li>
        ) : null}
      </ol>
    </div>
  )
}
