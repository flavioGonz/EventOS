// Widgets compartidos del panel admin: toasts, multi-select, cabecera, estados.
import { createContext, useCallback, useContext, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon, Spinner, EmptyState, Button, Glass, TextInput, Skeleton } from '../ui/primitives.jsx'

/* ---------- Skeleton de tabla (carga) ---------- */
export function TableSkeleton({ rows = 6, cols = 5 }) {
  return (
    <div className="adm-table-wrap">
      <table className="adm-table skel-table">
        <tbody>
          {Array.from({ length: rows }).map((_, i) => (
            <tr key={i}>
              {Array.from({ length: cols }).map((_, j) => (
                <td key={j}>
                  <Skeleton w={j === 0 ? '62%' : j === cols - 1 ? '44px' : '72%'} h={12} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/* ---------- Toasts ---------- */
const ToastCtx = createContext(() => {})
export function useToast() { return useContext(ToastCtx) }

const TOAST_LIFE = 3200
const TOAST_EXIT = 180
export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])
  const idRef = useRef(0)
  // Marca el toast como saliente (reproduce la animación de salida) y luego lo desmonta.
  const dismiss = useCallback((id) => {
    setToasts((t) => t.map((x) => (x.id === id ? { ...x, leaving: true } : x)))
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), TOAST_EXIT)
  }, [])
  const push = useCallback((message, tone = 'ok') => {
    const id = ++idRef.current
    setToasts((t) => [...t, { id, message, tone, leaving: false }])
    setTimeout(() => dismiss(id), TOAST_LIFE)
  }, [dismiss])
  return (
    <ToastCtx.Provider value={push}>
      {children}
      {createPortal(
        <div className="toast-stack" aria-live="polite">
          {toasts.map((t) => (
            <div key={t.id} className={`glass toast toast--${t.tone}${t.leaving ? ' is-leaving' : ''}`}
                 role="status" onClick={() => dismiss(t.id)}>
              <span className="ic"><Icon name={t.tone === 'ok' ? 'check' : 'alert'} size={17} /></span>
              <span>{t.message}</span>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastCtx.Provider>
  )
}

/* ---------- Cabecera de página ---------- */
export function PageHead({ title, subtitle, actions }) {
  return (
    <div className="admin-head">
      <div className="admin-head__titles">
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {actions && <div className="admin-head__actions">{actions}</div>}
    </div>
  )
}

/* ---------- Panel de ayuda por sección (guía para el técnico) ----------
   Callout explicativo, descartable, que aparece arriba de cada sección para
   orientar a quien configura el sistema. Recuerda el descarte en localStorage
   por clave (id de sección) para no repetir. */
export function SectionHelp({ id, icon = 'doc', title, children }) {
  const key = id ? `eventos.help.${id}` : null
  const [open, setOpen] = useState(() => { try { return key ? localStorage.getItem(key) !== '0' : true } catch { return true } })
  if (!open) return null
  const dismiss = () => { setOpen(false); try { if (key) localStorage.setItem(key, '0') } catch { /* noop */ } }
  return (
    <div className="sechelp" role="note">
      <span className="sechelp__ic"><Icon name={icon} size={16} /></span>
      <div className="sechelp__body">
        {title && <b className="sechelp__title">{title}</b>}
        <p className="sechelp__text">{children}</p>
      </div>
      <button type="button" className="sechelp__x" onClick={dismiss} aria-label="Ocultar ayuda"><Icon name="x" size={15} /></button>
    </div>
  )
}

/* ---------- Plantilla común de páginas de colección ----------
   Unifica todas las vistas de listado del admin: cabecera + barra de búsqueda
   opcional + estados (cargando / error / vacío / sin resultados) + tabla con
   scroll horizontal responsive. Las páginas solo aportan datos y la tabla. */
export function CollectionView({
  title, subtitle, newLabel, onNew, headActions,
  help,                   // opcional: { id, title, text } → panel de ayuda descartable
  beforeCard,             // opcional: nodo entre la cabecera y la tarjeta (resúmenes, KPIs)
  search,                 // opcional: { value, onChange, placeholder }
  toolbarExtra,           // opcional: nodo extra en la barra (filtros, etc.)
  loading, error, onRetry, loadingCols = 5,
  isEmpty, empty,         // empty: { icon, title, children } — sin datos
  isNoResults, noResults, // noResults: { children } — la búsqueda no casó nada
  children,               // la <table> cuando hay datos
}) {
  const actions = (
    <>
      {headActions}
      {onNew && <Button variant="primary" icon="plus" onClick={onNew}>{newLabel}</Button>}
    </>
  )
  return (
    <div className="anim-rise">
      <PageHead title={title} subtitle={subtitle} actions={(onNew || headActions) ? actions : null} />
      {help && <SectionHelp id={help.id} icon={help.icon} title={help.title}>{help.text}</SectionHelp>}
      {beforeCard}
      <Glass className="panel collection-card">
        {(search || toolbarExtra) && (
          <div className="collection-toolbar">
            {search && (
              <div className="admin-search">
                <Icon name="search" size={16} />
                <TextInput
                  placeholder={search.placeholder || 'Buscar…'}
                  value={search.value}
                  onChange={(e) => search.onChange(e.target.value)}
                  aria-label={search.placeholder || 'Buscar'}
                />
              </div>
            )}
            {toolbarExtra}
          </div>
        )}
        <div className="collection-body">
          {loading ? <TableSkeleton cols={loadingCols} />
            : error ? <ErrorState error={error} onRetry={onRetry} />
            : isEmpty ? (
                <EmptyState icon={empty?.icon} title={empty?.title}>{empty?.children}</EmptyState>
              )
            : isNoResults ? (
                <EmptyState icon="search" title="Sin resultados">
                  {noResults?.children || 'Ningún elemento coincide con la búsqueda.'}
                </EmptyState>
              )
            : <div className="adm-table-wrap">{children}</div>}
        </div>
      </Glass>
    </div>
  )
}

/* ---------- Página de edición (entidad como página dedicada, no modal) ---------- */
export function EditPage({ title, subtitle, onCancel, onSave, saving, children }) {
  return (
    <div className="anim-rise">
      <PageHead title={title} subtitle={subtitle}
        actions={(onCancel || onSave) ? (
          <>
            {onCancel && <Button variant="ghost" onClick={onCancel}>Cancelar</Button>}
            {onSave && <Button variant="primary" icon={saving ? undefined : 'check'} disabled={saving} onClick={onSave}>
              {saving ? <Spinner size={15} /> : 'Guardar'}
            </Button>}
          </>
        ) : null} />
      <Glass className="panel"><div className="panel__body">{children}</div></Glass>
    </div>
  )
}

/* ---------- Estados de colección ---------- */
export function Loading({ label = 'Cargando…' }) {
  return <div className="admin-center"><Spinner size={22} /><span>{label}</span></div>
}
export function ErrorState({ error, onRetry }) {
  return (
    <div className="admin-center">
      <Icon name="alert" size={26} />
      <span>{error?.message || 'No se pudo cargar'}</span>
      {onRetry && <Button size="sm" icon="bell" onClick={onRetry}>Reintentar</Button>}
    </div>
  )
}
export { EmptyState }

/* ---------- Multi-select por chips ---------- */
export function ChipMulti({ value = [], options = [], onChange }) {
  const set = new Set(value)
  const toggle = (v) => {
    const next = new Set(set)
    if (next.has(v)) next.delete(v); else next.add(v)
    onChange?.(Array.from(next))
  }
  return (
    <div className="chips">
      {options.map((o) => {
        const v = typeof o === 'string' ? o : o.value
        const lbl = typeof o === 'string' ? o : o.label
        const on = set.has(v)
        return (
          <button type="button" key={v} className={`chip${on ? ' is-on' : ''}`} onClick={() => toggle(v)}>
            <span className="chip__check"><Icon name="check" size={13} /></span>
            {lbl}
          </button>
        )
      })}
    </div>
  )
}

/* ---------- Entrada de tags libre (coma / enter) ---------- */
export function TagInput({ value = [], onChange, placeholder = 'Añadir y Enter…' }) {
  const [draft, setDraft] = useState('')
  const add = (raw) => {
    const t = raw.trim()
    if (!t) return
    if (!value.includes(t)) onChange?.([...value, t])
    setDraft('')
  }
  return (
    <div>
      <div className="inline-tags" style={{ marginBottom: value.length ? 8 : 0 }}>
        {value.map((t) => (
          <span key={t} className="chip is-on" onClick={() => onChange?.(value.filter((x) => x !== t))}>
            {t} <Icon name="x" size={12} />
          </span>
        ))}
      </div>
      <input
        className="input"
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(draft) }
          else if (e.key === 'Backspace' && !draft && value.length) onChange?.(value.slice(0, -1))
        }}
        onBlur={() => add(draft)}
      />
    </div>
  )
}

// Confirmación inline simple usando window.confirm (suficiente para borrados).
export function confirmDelete(name) {
  return window.confirm(`¿Eliminar “${name}”? Esta acción no se puede deshacer.`)
}
