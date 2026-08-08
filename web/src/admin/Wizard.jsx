// Wizard — asistente paso a paso reutilizable (riel de pasos + navegación).
import { Icon, Button } from '../ui/primitives.jsx'

export function Wizard({ steps, step, onStep, onCancel, onFinish, canNext = true, finishing = false, finishLabel = 'Crear', jumpable = false, children }) {
  const last = step >= steps.length - 1
  const n = steps.length
  const prog = n > 1 ? (step / (n - 1)) * 100 : 0
  return (
    <div className="wiz">
      {/* Riel de pasos animado: barra de progreso que crece + nodos con icono,
          anillo pulsante en el actual y check al completar. */}
      <div className="wsteps" style={{ '--n': n, '--prog': `${prog}%` }}>
        <span className="wsteps__track"><span className="wsteps__fill" /></span>
        {steps.map((s, i) => {
          const state = i === step ? ' is-cur' : i < step ? ' is-done' : ''
          const clickable = jumpable || i < step
          const inner = (
            <>
              <span className="wnode__dot">
                <span className="wnode__ring" />
                <span className="wnode__glyph">
                  {i < step
                    ? <Icon name="check" size={17} />
                    : (s.icon ? <Icon name={s.icon} size={19} /> : <b>{i + 1}</b>)}
                </span>
              </span>
              <span className="wnode__txt">
                <span className="wnode__n">Paso {i + 1}</span>
                <span className="wnode__lbl">{s.label}</span>
              </span>
            </>
          )
          return clickable
            ? <button type="button" key={s.key || i} className={`wnode${state}`} onClick={() => onStep(i)}>{inner}</button>
            : <div key={s.key || i} className={`wnode${state}`}>{inner}</div>
        })}
      </div>

      <div className="wiz__body anim-rise" key={step}>{children}</div>

      <div className="wiz__nav">
        <Button variant="ghost" onClick={step === 0 ? onCancel : () => onStep(step - 1)}>
          {step === 0 ? 'Cancelar' : '← Atrás'}
        </Button>
        <span className="wiz__sp" />
        {!last
          ? <Button variant="primary" iconRight="chevron" disabled={!canNext} onClick={() => onStep(step + 1)}>Siguiente</Button>
          : <Button variant="primary" icon="check" disabled={finishing || !canNext} onClick={onFinish}>{finishing ? 'Creando…' : finishLabel}</Button>}
      </div>
    </div>
  )
}

export default Wizard
