import { useEffect, useState } from 'react'
import { Button, Field, Icon, Skeleton, TextInput } from '../ui/primitives.jsx'
import { setAdminToken } from '../lib/adminApi.js'

const ROLE_LABEL = { agente: 'Agente', supervisor: 'Supervisor', admin: 'Admin' }

// Login del operario: elige su perfil (avatar + nombre) de los operarios reales
// definidos en Admin, de modo que su operatorId coincida con el del sistema
// (grupos, despacho dirigido y skills funcionan correctamente). Fallback manual
// si no hay operarios o si quiere entrar con otro nombre.

const SKILLS = ['video', 'access', 'intrusion', 'system']

function initials(name = '') {
  return name.trim().split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase() || '·'
}
function hueFor(s = '') {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return h % 360
}

export default function OperatorIdentity({ onConfirm }) {
  const [ops, setOps] = useState(null) // null = cargando, [] = ninguno
  const [manual, setManual] = useState(false)
  const [name, setName] = useState('')
  const [skills, setSkills] = useState(['video', 'access'])
  const [pending, setPending] = useState(null) // operario elegido esperando PIN
  const [pin, setPin] = useState('')
  const [pinErr, setPinErr] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    fetch('/api/roster')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive) setOps(d && Array.isArray(d.operators) ? d.operators : []) })
      .catch(() => { if (alive) setOps([]) })
    return () => { alive = false }
  }, [])

  // Login contra el server: verifica PIN (si lo tiene) y devuelve rol + token admin.
  async function doLogin(op, pinVal) {
    setBusy(true); setPinErr('')
    try {
      const r = await fetch('/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operatorId: op.id, pin: pinVal || '' }),
      })
      const data = await r.json().catch(() => ({}))
      if (!r.ok || !data.ok) {
        setBusy(false)
        setPinErr(data.error === 'bad_pin' ? 'PIN incorrecto' : 'No se pudo iniciar sesión')
        return
      }
      if (data.adminToken) setAdminToken(data.adminToken) // solo rol admin
      const o = data.operator
      onConfirm({ operatorId: o.operatorId, name: o.name, skills: o.skills || [], role: o.role || 'agente' })
    } catch {
      setBusy(false); setPinErr('Error de red')
    }
  }

  function pick(o) {
    if (o.hasPin) { setPending(o); setPin(''); setPinErr('') } // pedir PIN
    else doLogin(o, '')                                        // sin PIN → directo
  }
  function toggleSkill(s) {
    setSkills((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]))
  }
  function confirmManual() {
    const clean = name.trim()
    if (!clean) return
    const slug = clean.toLowerCase().normalize('NFD')
      .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
    onConfirm({ operatorId: 'op_' + (slug || 'op') + '_' + Math.random().toString(36).slice(2, 6), name: clean, skills, role: 'agente' })
  }

  const showManual = manual || (ops && ops.length === 0)

  return (
    <div className="identity-wrap">
      <div className="identity glass glass--strong anim-pop" role="dialog" aria-modal="true">
        <div className="identity__brand">
          <span className="identity__logo"><Icon name="bolt" size={22} /></span>
          <h1>EventOS</h1>
          <p>Consola de Operación · Elige tu perfil</p>
        </div>

        {ops === null ? (
          <div className="op-grid">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="op-card op-card--skel">
                <Skeleton w="46px" h="46px" r="50%" />
                <Skeleton w="62%" h={11} />
                <Skeleton w="44%" h={9} />
              </div>
            ))}
          </div>
        ) : pending ? (
          <div className="pinview">
            <span className="op-card__av pinview__av" style={{ background: `hsl(${hueFor(pending.id || pending.name)} 52% 42%)` }}>
              {initials(pending.name)}
            </span>
            <p className="pinview__name">{pending.name}
              <span className={`op-role op-role--${pending.role || 'agente'}`}>{ROLE_LABEL[pending.role] || 'Agente'}</span>
            </p>
            <Field label="Introduce tu PIN" error={pinErr}>
              <TextInput className="input--lg pinview__input" type="password" inputMode="numeric" autoFocus
                placeholder="••••" value={pin} maxLength={8}
                onChange={(e) => { setPin(e.target.value.replace(/\D/g, '')); setPinErr('') }}
                onKeyDown={(e) => e.key === 'Enter' && !busy && pin && doLogin(pending, pin)} />
            </Field>
            <Button variant="primary" size="md" className="identity__go" iconRight="chevron"
              onClick={() => doLogin(pending, pin)} disabled={busy || !pin}>
              {busy ? 'Verificando…' : 'Entrar'}
            </Button>
            <Button variant="ghost" size="sm" className="identity__go" onClick={() => { setPending(null); setPin(''); setPinErr('') }}>
              ← Elegir otro perfil
            </Button>
          </div>
        ) : !showManual ? (
          <>
            <div className="op-grid">
              {ops.map((o) => (
                <button key={o.id} type="button" className="op-card" onClick={() => pick(o)}>
                  <span className="op-card__av" style={{ background: `hsl(${hueFor(o.id || o.name)} 52% 42%)` }}>
                    {initials(o.name)}
                  </span>
                  <span className="op-card__name">{o.name}</span>
                  <span className={`op-role op-role--${o.role || 'agente'}`}>{ROLE_LABEL[o.role] || 'Agente'}{o.hasPin ? ' · PIN' : ''}</span>
                </button>
              ))}
            </div>
            <Button variant="ghost" size="sm" className="identity__go" onClick={() => setManual(true)}>
              Entrar con otro nombre
            </Button>
          </>
        ) : (
          <>
            <Field label="Identifícate, operario">
              <TextInput id="opname" className="input--lg" type="text" autoFocus
                placeholder="Nombre y apellido" value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && confirmManual()} />
            </Field>
            <div className="identity__skills">
              <span className="identity__skills-label">Habilidades</span>
              <div className="identity__skills-grid">
                {SKILLS.map((s) => (
                  <button key={s} type="button"
                    className={`chip-toggle ${skills.includes(s) ? 'is-on' : ''}`}
                    aria-pressed={skills.includes(s)} onClick={() => toggleSkill(s)}>
                    {skills.includes(s) && <Icon name="check" size={13} />}{s}
                  </button>
                ))}
              </div>
            </div>
            <Button variant="primary" size="md" className="identity__go" iconRight="chevron"
              onClick={confirmManual} disabled={!name.trim()}>
              Entrar a la consola
            </Button>
            {ops.length > 0 && (
              <Button variant="ghost" size="sm" className="identity__go" onClick={() => setManual(false)}>
                ← Elegir de la lista
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  )
}
