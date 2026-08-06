import { useState } from 'react'
import { Button, Field, Icon, TextInput } from '../ui/primitives.jsx'
import { setAdminToken } from '../lib/adminApi.js'

// Login de la consola: usuario + contraseña. La sesión (cookie) que emite el
// server autoriza TODA la consola, el video, las acciones físicas y el socket.
// El rol devuelto define qué paneles ve el usuario (agente/supervisor/admin).
export default function Login({ onConfirm }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  async function submit(e) {
    if (e) e.preventDefault()
    const u = username.trim()
    if (!u || !password) { setErr('Ingresá usuario y contraseña'); return }
    setBusy(true); setErr('')
    try {
      const r = await fetch('/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: u, password }),
      })
      const data = await r.json().catch(() => ({}))
      if (!r.ok || !data.ok) {
        setBusy(false)
        setErr(data.error === 'bad_credentials' ? 'Usuario o contraseña incorrectos' : 'No se pudo iniciar sesión')
        return
      }
      if (data.adminToken) setAdminToken(data.adminToken)
      const o = data.operator
      onConfirm({ operatorId: o.operatorId, name: o.name, username: o.username, skills: o.skills || [], role: o.role || 'agente' })
    } catch {
      setBusy(false); setErr('Error de red')
    }
  }

  return (
    <div className="login-wrap">
      <form className="login glass glass--strong anim-pop" onSubmit={submit} role="dialog" aria-modal="true">
        <div className="login__brand">
          <span className="login__logo"><Icon name="bolt" size={24} /></span>
          <h1>EventOS</h1>
          <p>Central Receptora de Alarmas · Ingreso</p>
        </div>

        <Field label="Usuario">
          <TextInput className="input--lg" type="text" autoFocus autoComplete="username"
            placeholder="usuario" value={username}
            onChange={(e) => { setUsername(e.target.value); setErr('') }} />
        </Field>

        <Field label="Contraseña" error={err}>
          <TextInput className="input--lg" type="password" autoComplete="current-password"
            placeholder="••••••••" value={password}
            onChange={(e) => { setPassword(e.target.value); setErr('') }} />
        </Field>

        <Button type="submit" variant="primary" size="md" className="login__go" iconRight="chevron"
          disabled={busy || !username.trim() || !password}>
          {busy ? 'Verificando…' : 'Entrar'}
        </Button>

        <p className="login__hint">Acceso restringido a personal autorizado.</p>
      </form>
    </div>
  )
}
