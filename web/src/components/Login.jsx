import { useEffect, useRef, useState } from 'react'
import { Button, Field, Icon, TextInput } from '../ui/primitives.jsx'
import { setAdminToken } from '../lib/adminApi.js'

// Login de la consola: usuario + contraseña. La sesión (cookie) que emite el
// server autoriza TODA la consola, el video, las acciones físicas y el socket.
// El rol devuelto define qué paneles ve el usuario (agente/supervisor/admin).
//
// Layout de doble panel: formulario a la izquierda, y a la derecha una vista
// ESTILIZADA del sistema (mock animado del Centro de Verificación en Vivo). Todo
// con tokens de theme.css → se ve bien en claro y oscuro. En pantallas angostas
// el panel derecho se oculta y queda solo el formulario.
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
    <div className="login2">
      {/* IZQUIERDA — formulario */}
      <div className="login2__left">
        <form className="login glass glass--strong anim-pop" onSubmit={submit} role="dialog" aria-modal="true">
          <div className="login__brand">
            <span className="login__logo"><Icon name="brand" size={24} /></span>
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

      {/* DERECHA — vista estilizada del sistema (decorativa) */}
      <aside className="login2__right">
        <ShowcasePanel />
        <WinAppLink />
      </aside>
    </div>
  )
}

// Panel derecho: ESCENA VIVA del Centro de Verificación — los eventos LLEGAN uno
// a uno (deslizan desde arriba con un flash), corren su SLA y se despachan. Es un
// bucle animado que evoca el producto real: recepción de alarmas en tiempo real.
const EV_POOL = [
  { t: 'Cruce de línea', z: 'Frente · Cámara 2', p: 'crit', ic: 'linecross' },
  { t: 'Intrusión perimetral', z: 'Depósito · Cámara 5', p: 'crit', ic: 'zone' },
  { t: 'Puerta forzada', z: 'Acceso principal', p: 'hi', ic: 'shield' },
  { t: 'Merodeo detectado', z: 'Estacionamiento', p: 'hi', ic: 'user' },
  { t: 'Rostro en lista', z: 'Recepción · Cámara 1', p: 'hi', ic: 'face' },
  { t: 'Vehículo no autorizado', z: 'Portón · Cámara 8', p: 'mid', ic: 'car' },
  { t: 'Pánico', z: 'Caja · botón SOS', p: 'crit', ic: 'siren' },
  { t: 'Movimiento nocturno', z: 'Pasillo · Cámara 3', p: 'mid', ic: 'bolt' },
  { t: 'Sabotaje de cámara', z: 'Fondo · Cámara 6', p: 'hi', ic: 'alert' },
]

function ShowcasePanel() {
  const [rows, setRows] = useState(() => EV_POOL.slice(0, 4).map((e, i) => ({ ...e, id: i, sla: 20 + i * 15, taken: i === 3 })))
  const nextId = useRef(rows.length)
  const pick = useRef(4)

  useEffect(() => {
    // Cada ~2.4s: llega un evento nuevo arriba, corre el SLA de todos y el más
    // viejo se despacha (sale). Bucle infinito, liviano (5 filas máx).
    const t = setInterval(() => {
      setRows((prev) => {
        const base = EV_POOL[pick.current % EV_POOL.length]; pick.current += 1
        const arriving = { ...base, id: nextId.current++, sla: 0, taken: false, arriving: true }
        const aged = prev.map((r) => ({ ...r, sla: r.sla + 3, arriving: false }))
        // marca uno del medio como "tomado" (verificándose)
        if (aged[1]) aged[1] = { ...aged[1], taken: true }
        const next = [arriving, ...aged]
        return next.slice(0, 5)
      })
    }, 2400)
    return () => clearInterval(t)
  }, [])

  const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

  return (
    <div className="lshow" aria-hidden="true">
      <div className="lshow__glow" />
      <div className="lshow__card glass glass--strong">
        <div className="lshow__bar">
          <span className="lshow__dot" /><span className="lshow__dot" /><span className="lshow__dot" />
          <span className="lshow__title"><Icon name="video" size={13} /> Centro de Verificación en Vivo</span>
          <span className="lshow__livewrap"><span className="lshow__livedot" /> EN VIVO</span>
        </div>
        <div className="lshow__rows">
          {rows.map((r) => (
            <div key={r.id} className={`lshow__row lshow__row--${r.p}${r.arriving ? ' is-arriving' : ''}${r.taken ? ' is-taken' : ''}`}>
              <span className={`lshow__ic lshow__ic--${r.p}`}><Icon name={r.ic} size={14} /></span>
              <span className="lshow__ev">
                <b>{r.t}</b>
                <small>{r.z}</small>
              </span>
              {r.taken
                ? <span className="lshow__tag"><span className="lshow__tagdot" /> Verificando</span>
                : <span className={`lshow__sla lshow__sla--${r.p}`}>SLA {mmss(r.sla)}</span>}
            </div>
          ))}
        </div>
        <div className="lshow__selbar">
          <span className="lshow__pill lshow__pill--real"><Icon name="siren" size={13} /> Alarma real</span>
          <span className="lshow__pill lshow__pill--false"><Icon name="shieldcheck" size={13} /> Falsa alarma</span>
          <span className="lshow__pill"><Icon name="check" size={13} /> Tomar</span>
        </div>
      </div>

      <div className="lshow__copy">
        <h2>Recepción de alarmas, en tiempo real.</h2>
        <p>Los eventos llegan, se verifican con video en vivo y analíticas, y se despachan siguiendo el procedimiento — todo en una sola pantalla.</p>
        <ul className="lshow__feats">
          <li><Icon name="video" size={15} /> Verificación en vivo con analíticas</li>
          <li><Icon name="bolt" size={15} /> Despacho con SLA y escalado</li>
          <li><Icon name="shieldcheck" size={15} /> Multi-vendor · Hikvision · Akuvox</li>
        </ul>
      </div>
    </div>
  )
}

// WinAppLink — link para DESCARGAR la app de escritorio (Windows) desde el login.
// Consulta /api/desktop/latest para mostrar versión y tamaño; si hay instalador,
// el botón baja /api/desktop/download. Si no hay ninguno publicado, se oculta.
function WinAppLink() {
  const [info, setInfo] = useState(undefined) // undefined=cargando | null=no hay | {version,size}
  useEffect(() => {
    let alive = true
    fetch('/api/desktop/latest')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive) setInfo(d && d.available !== false && (d.version || d.filename || d.sizeBytes) ? d : null) })
      .catch(() => { if (alive) setInfo(null) })
    return () => { alive = false }
  }, [])
  if (info === undefined || info === null) return null
  const bytes = info.sizeBytes || info.size
  const mb = bytes ? (bytes / (1024 * 1024)).toFixed(0) + ' MB' : null
  const meta = [info.version ? `v${info.version}` : null, mb].filter(Boolean).join(' · ')
  return (
    <div className="login2__winwrap">
      <a className="wdlbtn" href="/api/desktop/download" download title={`Descargar la consola de escritorio${meta ? ` (${meta})` : ''}`}>
        <svg className="wdlbtn__logo" viewBox="0 0 24 24" aria-hidden="true">
          <path fill="currentColor" d="M2.5 4.6 L11 3.35 V11.2 H2.5 Z M12.2 3.18 L21.5 2 V11.2 H12.2 Z M2.5 12.4 H11 V20.25 L2.5 19 Z M12.2 12.4 H21.5 V22 L12.2 20.82 Z" />
        </svg>
        <span className="wdlbtn__tx"><small>Download for</small><b>Windows</b></span>
      </a>
      {meta && <span className="login2__winmeta">Consola de escritorio · {meta}</span>}
    </div>
  )
}
