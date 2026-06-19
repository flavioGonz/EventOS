// Primitivas de UI compartidas (Apple / liquid glass). CONTRACT-V2 §4.
// Usadas tanto por la consola del operario como por el panel de administración.
import { useEffect, useRef, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import './primitives.css'
import { Icon } from './icons.jsx'
import { useTheme } from './ThemeProvider.jsx'

export { Icon } from './icons.jsx'
export { useTheme } from './ThemeProvider.jsx'

const cx = (...c) => c.filter(Boolean).join(' ')

/* ---------- Superficies ---------- */
export function Glass({ as: As = 'div', strong, className, children, ...rest }) {
  return <As className={cx('glass', strong && 'glass--strong', className)} {...rest}>{children}</As>
}

export function Panel({ title, subtitle, actions, className, children, ...rest }) {
  return (
    <Glass className={cx('panel', className)} {...rest}>
      {(title || actions) && (
        <header className="panel__head">
          <div className="panel__titles">
            {title && <h3 className="panel__title">{title}</h3>}
            {subtitle && <p className="panel__sub">{subtitle}</p>}
          </div>
          {actions && <div className="panel__actions">{actions}</div>}
        </header>
      )}
      <div className="panel__body">{children}</div>
    </Glass>
  )
}

/* ---------- Botones ---------- */
export function Button({ variant = 'secondary', size = 'md', icon, iconRight, className, children, ...rest }) {
  return (
    <button className={cx('btn', `btn--${variant}`, `btn--${size}`, className)} {...rest}>
      {icon && <Icon name={icon} size={size === 'sm' ? 15 : 17} />}
      {children && <span>{children}</span>}
      {iconRight && <Icon name={iconRight} size={size === 'sm' ? 15 : 17} />}
    </button>
  )
}

export function IconButton({ icon, label, size = 'md', variant = 'ghost', className, ...rest }) {
  return (
    <button className={cx('icon-btn', `icon-btn--${size}`, `btn--${variant}`, className)}
            aria-label={label} title={label} {...rest}>
      <Icon name={icon} size={size === 'sm' ? 16 : 18} />
    </button>
  )
}

/* ---------- Switch (iOS) ---------- */
export function Switch({ checked, onChange, label, id, ...rest }) {
  // rest (p. ej. aria-label) va al control real (input), no al <label> contenedor.
  return (
    <label className="switch">
      <input type="checkbox" id={id} checked={!!checked}
             onChange={(e) => onChange?.(e.target.checked)} {...rest} />
      <span className="switch__track"><span className="switch__thumb" /></span>
      {label && <span className="switch__label">{label}</span>}
    </label>
  )
}

/* ---------- Segmented control ---------- */
export function Segmented({ value, onChange, options = [] }) {
  return (
    <div className="segmented" role="tablist">
      {options.map((o) => {
        const v = typeof o === 'string' ? o : o.value
        const lbl = typeof o === 'string' ? o : o.label
        return (
          <button key={v} role="tab" aria-selected={value === v}
                  className={cx('segmented__opt', value === v && 'is-active')}
                  onClick={() => onChange?.(v)}>
            {lbl}
          </button>
        )
      })}
    </div>
  )
}

/* ---------- Formularios ---------- */
export function Field({ label, hint, error, className, children }) {
  return (
    <label className={cx('field', className)}>
      {label && <span className="field__label">{label}</span>}
      {children}
      {error ? <span className="field__error">{error}</span>
             : hint ? <span className="field__hint">{hint}</span> : null}
    </label>
  )
}
export function TextInput({ className, ...rest })  { return <input className={cx('input', className)} {...rest} /> }
export function Textarea({ className, ...rest })   { return <textarea className={cx('input', 'input--area', className)} {...rest} /> }
export function Select({ className, children, ...rest }) {
  return (
    <div className={cx('select', className)}>
      <select {...rest}>{children}</select>
      <Icon name="chevron" size={15} className="select__chev" />
    </div>
  )
}

/* ---------- Combobox (select con búsqueda + creación inline) ----------
   options: [{ value, label }] (label string o nodo; búsqueda por searchText||label).
   onCreate(text) => devuelve el value nuevo (o promesa) para crear opciones al vuelo. */
export function Combobox({
  value, onChange, options = [], placeholder = 'Seleccionar…',
  searchPlaceholder = 'Buscar…', emptyText = 'Sin resultados',
  onCreate, createLabel = 'Crear', disabled, className,
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const rootRef = useRef(null)
  const inputRef = useRef(null)
  const selected = options.find((o) => o.value === value) || null

  useEffect(() => {
    if (!open) return
    const onDown = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])
  useEffect(() => { if (open) { setQ(''); setTimeout(() => inputRef.current?.focus(), 0) } }, [open])

  const term = q.trim().toLowerCase()
  const textOf = (o) => String(o.searchText ?? (typeof o.label === 'string' ? o.label : o.value ?? '')).toLowerCase()
  const filtered = !term ? options : options.filter((o) => textOf(o).includes(term))
  const exact = options.some((o) => textOf(o) === term)
  const canCreate = !!onCreate && term.length > 0 && !exact

  const choose = (v) => { onChange?.(v); setOpen(false) }
  const create = async () => { const v = await onCreate(q.trim()); if (v != null) choose(v) }

  return (
    <div ref={rootRef} className={cx('combobox', open && 'is-open', disabled && 'is-disabled', className)}>
      <button type="button" className="combobox__control" disabled={disabled}
              aria-haspopup="listbox" aria-expanded={open}
              onClick={() => !disabled && setOpen((o) => !o)}>
        <span className={cx('combobox__value', !selected && 'is-placeholder')}>
          {selected ? selected.label : placeholder}
        </span>
        <Icon name="chevron" size={15} className="combobox__chev" />
      </button>
      {open && (
        <div className="combobox__pop glass glass--strong">
          <div className="combobox__search">
            <Icon name="search" size={15} />
            <input ref={inputRef} className="combobox__input" value={q} placeholder={searchPlaceholder}
                   onChange={(e) => setQ(e.target.value)}
                   onKeyDown={(e) => {
                     if (e.key === 'Escape') setOpen(false)
                     else if (e.key === 'Enter') { e.preventDefault(); if (canCreate) create(); else if (filtered[0]) choose(filtered[0].value) }
                   }} />
          </div>
          <ul className="combobox__list" role="listbox">
            {filtered.map((o) => (
              <li key={o.value}>
                <button type="button" className={cx('combobox__opt', o.value === value && 'is-sel')}
                        onClick={() => choose(o.value)}>
                  <span className="combobox__opt-lbl">{o.label}</span>
                  {o.value === value && <Icon name="check" size={14} />}
                </button>
              </li>
            ))}
            {filtered.length === 0 && !canCreate && <li className="combobox__empty">{emptyText}</li>}
          </ul>
          {canCreate && (
            <button type="button" className="combobox__create" onClick={create}>
              <Icon name="plus" size={14} /> {createLabel} «{q.trim()}»
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/* ---------- Badges / tags ---------- */
export function Badge({ tone = 'neutral', children, className, ...rest }) {
  return <span className={cx('badge', `badge--${tone}`, className)} {...rest}>{children}</span>
}
export function PriorityDot({ p = 5, size = 10 }) {
  return <span className="prio-dot" style={{ '--c': `var(--p${p})`, width: size, height: size }} />
}

/* ---------- Modal (scrim blur + spring, con animación de entrada Y salida) ---------- */
const MODAL_EXIT_MS = 170
export function Modal({ open = true, onClose, title, size = 'md', children, footer }) {
  const [closing, setClosing] = useState(false)
  // requestClose: reproduce la animación de salida y RECIÉN ahí avisa al padre,
  // así funciona incluso si el padre desmonta condicionalmente ({open && <Modal/>}).
  const requestClose = useCallback(() => {
    setClosing((c) => {
      if (c) return c
      setTimeout(() => { setClosing(false); onClose?.() }, MODAL_EXIT_MS)
      return true
    })
  }, [onClose])
  useEffect(() => {
    if (!open) return
    const onKey = (e) => { if (e.key === 'Escape') requestClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, requestClose])
  if (!open && !closing) return null
  // Portal a <body>: evita que un ancestro con transform/animación/backdrop-filter
  // "atrape" el position:fixed y recorte el modal o su cabecera.
  return createPortal(
    // El clic fuera NO cierra (evita cierres accidentales mientras se atiende):
    // solo la cruz (o Escape) cierran.
    <div className={cx('modal-scrim', closing && 'is-closing')}>
      <Glass strong className={cx('modal', `modal--${size}`, closing && 'is-closing')}
             role="dialog" aria-modal="true">
        {title && (
          <header className="modal__head">
            <h2 className="modal__title">{title}</h2>
            <IconButton icon="x" label="Cerrar" onClick={requestClose} />
          </header>
        )}
        <div className="modal__body">{children}</div>
        {footer && <footer className="modal__foot">{footer}</footer>}
      </Glass>
    </div>,
    document.body,
  )
}

/* ---------- Varios ---------- */
export function Spinner({ size = 18 }) {
  return <span className="spinner" style={{ width: size, height: size }} aria-label="cargando" />
}

/* ---------- Skeleton (placeholder shimmer de carga) ---------- */
export function Skeleton({ w = '100%', h = 14, r, className, style }) {
  return <span className={cx('skel', className)} aria-hidden="true"
               style={{ width: w, height: typeof h === 'number' ? `${h}px` : h, borderRadius: r, ...style }} />
}
export function EmptyState({ icon = 'dot', title, children }) {
  return (
    <div className="empty">
      <Icon name={icon} size={28} />
      {title && <p className="empty__title">{title}</p>}
      {children && <p className="empty__sub">{children}</p>}
    </div>
  )
}
export function StatusDot({ tone = 'ok', label }) {
  return <span className={cx('status-dot', `status-dot--${tone}`)} title={label} />
}

/* ---------- Conmutador de tema (sol/luna) ---------- */
export function ThemeToggle() {
  const { theme, toggle } = useTheme()
  return (
    <button className="theme-toggle" onClick={toggle} aria-label="Cambiar tema"
            title={theme === 'dark' ? 'Tema claro' : 'Tema oscuro'}>
      <span className="theme-toggle__icons" data-theme-state={theme}>
        <Icon name="sun" size={17} />
        <Icon name="moon" size={17} />
      </span>
    </button>
  )
}
