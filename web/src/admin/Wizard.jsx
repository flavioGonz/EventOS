// Wizard — asistente paso a paso reutilizable (riel de pasos + navegación).
import { Icon, Button } from '../ui/primitives.jsx'

export function Wizard({ steps, step, onStep, onCancel, onFinish, canNext = true, finishing = false, finishLabel = 'Crear', jumpable = false, children }) {
  const last = step >= steps.length - 1
  return (
    <div className="wiz">
      <ol className="wiz__rail">
        {steps.map((s, i) => {
          const cls = `wiz__step${i === step ? ' is-cur' : ''}${i < step ? ' is-done' : ''}${jumpable ? ' is-jump' : ''}`
          const inner = <><span className="wiz__dot">{i < step ? <Icon name="check" size={13} /> : i + 1}</span><span className="wiz__lbl">{s.label}</span></>
          return jumpable
            ? <li key={s.key || i}><button type="button" className={cls} onClick={() => onStep(i)}>{inner}</button></li>
            : <li key={s.key || i} className={cls}>{inner}</li>
        })}
      </ol>

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
