// OperatorMenu.jsx — chip de avatar con menú: perfil + foto, cambiar contraseña,
// cambiar de operario y cerrar sesión. La foto se sube redimensionada (256px) a
// /api/auth/avatar; la clave se cambia por /api/auth/change-password (cookie).
import { useEffect, useRef, useState } from 'react'
import { Glass, Icon } from '../ui/primitives.jsx'

function initials(name = '') {
  return name.trim().split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase() || '·'
}

// Redimensiona/recorta cuadrado a `size` y devuelve dataURL JPEG.
function fileToSquareDataUrl(file, size = 256) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      try {
        const s = Math.min(img.width, img.height)
        const c = document.createElement('canvas'); c.width = size; c.height = size
        const ctx = c.getContext('2d')
        ctx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size)
        URL.revokeObjectURL(url)
        resolve(c.toDataURL('image/jpeg', 0.85))
      } catch (e) { reject(e) }
    }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('img')) }
    img.src = url
  })
}

const PW_ERR = {
  bad_current: 'La contraseña actual no es correcta.',
  weak_password: 'La nueva clave es muy corta (mínimo 4).',
  no_session: 'Sesión expirada, volvé a ingresar.',
}

export default function OperatorMenu({ operator, onChangeOperator }) {
  const [open, setOpen] = useState(false)
  const [view, setView] = useState('menu') // menu | password
  const [avatar, setAvatar] = useState(operator?.avatarUrl || null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null) // {tone,text}
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' })
  const ref = useRef(null)
  const fileRef = useRef(null)

  useEffect(() => { setAvatar(operator?.avatarUrl || null) }, [operator?.avatarUrl])
  useEffect(() => {
    if (!open) return
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) close() }
    const onKey = (e) => { if (e.key === 'Escape') close() }
    document.addEventListener('mousedown', onDown); document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])

  const close = () => { setOpen(false); setView('menu'); setMsg(null) }
  const role = operator?.role || 'agente'
  const roleLabel = role === 'admin' ? 'Administrador' : role === 'supervisor' ? 'Supervisor' : 'Agente'

  const persistAvatar = (url) => {
    try {
      const raw = localStorage.getItem('eventos.operator')
      if (raw) { const o = JSON.parse(raw); o.avatarUrl = url; localStorage.setItem('eventos.operator', JSON.stringify(o)) }
    } catch { /* noop */ }
  }

  const pickPhoto = () => fileRef.current && fileRef.current.click()
  const onPhoto = async (e) => {
    const file = e.target.files && e.target.files[0]
    e.target.value = ''
    if (!file) return
    setBusy(true); setMsg(null)
    try {
      const dataUrl = await fileToSquareDataUrl(file)
      const r = await fetch('/api/auth/avatar', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dataUrl }) })
      const j = await r.json().catch(() => ({}))
      if (r.ok && j.avatarUrl) { setAvatar(j.avatarUrl); persistAvatar(j.avatarUrl); setMsg({ tone: 'ok', text: 'Foto actualizada' }) }
      else setMsg({ tone: 'bad', text: 'No se pudo subir la foto' })
    } catch { setMsg({ tone: 'bad', text: 'No se pudo procesar la imagen' }) }
    finally { setBusy(false) }
  }

  const submitPw = async (e) => {
    e.preventDefault(); setMsg(null)
    if (pw.next.length < 4) return setMsg({ tone: 'bad', text: 'La nueva clave es muy corta (mínimo 4).' })
    if (pw.next !== pw.confirm) return setMsg({ tone: 'bad', text: 'Las claves nuevas no coinciden.' })
    setBusy(true)
    try {
      const r = await fetch('/api/auth/change-password', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ current: pw.current, next: pw.next }) })
      const j = await r.json().catch(() => ({}))
      if (r.ok && j.ok) { setMsg({ tone: 'ok', text: 'Contraseña cambiada' }); setPw({ current: '', next: '', confirm: '' }); setTimeout(() => setView('menu'), 900) }
      else setMsg({ tone: 'bad', text: PW_ERR[j.error] || 'No se pudo cambiar la clave.' })
    } catch { setMsg({ tone: 'bad', text: 'Error de conexión.' }) }
    finally { setBusy(false) }
  }

  const logout = async () => {
    try {
      if (window.eventosDesktop && window.eventosDesktop.auth && window.eventosDesktop.auth.logout) { await window.eventosDesktop.auth.logout(); return }
      await fetch('/api/auth/logout', { method: 'POST' })
    } catch { /* noop */ }
    try { localStorage.removeItem('eventos.operator') } catch { /* noop */ }
    if (onChangeOperator) onChangeOperator(); else window.location.reload()
  }

  const AvatarImg = ({ size }) => avatar
    ? <img className="opav__img" src={avatar} alt="" style={{ width: size, height: size }} onError={() => setAvatar(null)} />
    : <span className="opav__ini" style={{ width: size, height: size, fontSize: size * 0.4 }}>{initials(operator?.name)}</span>

  return (
    <div className="opmenu" ref={ref}>
      <button type="button" className="op-chip" onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open} title="Perfil / cuenta">
        <span className="op-chip__av op-chip__av--photo"><AvatarImg size={22} /></span>
        <span className="op-chip__name">{operator?.name}</span>
        {role !== 'agente' && <span className={`op-role op-role--${role}`}>{role === 'admin' ? 'Admin' : 'Supervisor'}</span>}
        <Icon name="chevron" size={13} />
      </button>

      {open && (
        <Glass strong className="opmenu__pop anim-pop" role="menu">
          <div className="opmenu__head">
            <span className="opav opav--lg" onClick={pickPhoto} title="Cambiar foto">
              <AvatarImg size={54} />
              <span className="opav__edit"><Icon name="camera" size={13} /></span>
            </span>
            <div className="opmenu__id">
              <b>{operator?.name}</b>
              <span className={`op-role op-role--${role}`}>{roleLabel}</span>
            </div>
          </div>
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={onPhoto} />

          {msg && <div className={`opmenu__msg t-${msg.tone}`}>{msg.text}</div>}

          {view === 'menu' ? (
            <div className="opmenu__list">
              <button type="button" className="opmenu__item" onClick={pickPhoto} disabled={busy}><Icon name="camera" size={15} /> Cambiar foto</button>
              <button type="button" className="opmenu__item" onClick={() => { setMsg(null); setView('password') }}><Icon name="shield" size={15} /> Cambiar contraseña</button>
              <button type="button" className="opmenu__item" onClick={() => { close(); onChangeOperator && onChangeOperator() }}><Icon name="users" size={15} /> Cambiar de operario</button>
              <div className="opmenu__sep" />
              <button type="button" className="opmenu__item opmenu__item--danger" onClick={logout}><Icon name="logout" size={15} /> Cerrar sesión</button>
            </div>
          ) : (
            <form className="opmenu__form" onSubmit={submitPw}>
              <input className="opmenu__in" type="password" placeholder="Contraseña actual" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} autoFocus />
              <input className="opmenu__in" type="password" placeholder="Nueva contraseña" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
              <input className="opmenu__in" type="password" placeholder="Repetir nueva" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} />
              <div className="opmenu__formfoot">
                <button type="button" className="opmenu__btn" onClick={() => { setView('menu'); setMsg(null) }}>Volver</button>
                <button type="submit" className="opmenu__btn opmenu__btn--primary" disabled={busy}>{busy ? 'Guardando…' : 'Guardar'}</button>
              </div>
            </form>
          )}
        </Glass>
      )}
    </div>
  )
}
