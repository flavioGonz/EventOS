// AkuvoxUsers — lee y muestra TODO lo que el portero Akuvox tiene cargado por
// persona (SmartPlus user/get): nombre, tarjeta RFID, PIN privado y rostro. Con
// buscador, conteos y paginación. El rostro se sirve por proxy del server.
import { useEffect, useMemo, useState } from 'react'
import { Icon, Spinner, Button, Badge, TextInput } from '../ui/primitives.jsx'

const PER = 20

export default function AkuvoxUsers({ deviceId, isNew, onCount }) {
  const [data, setData] = useState(undefined)
  const [q, setQ] = useState('')
  const [page, setPage] = useState(0)
  const [reveal, setReveal] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [only, setOnly] = useState('all') // all | card | pin | face
  const [edit, setEdit] = useState(null)  // null | {userId?, name, card, pin, group}
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)    // {tone:'ok'|'err', text}
  const [zoom, setZoom] = useState(null)  // URL del rostro ampliado (modal) | null

  useEffect(() => {
    if (isNew || !deviceId) return
    let alive = true
    setData(undefined)
    fetch(`/api/device/${deviceId}/akuvox-users`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('http'))))
      .then((d) => { if (alive) setData(d || { users: [] }) })
      .catch(() => { if (alive) setData({ users: [], error: true }) })
    return () => { alive = false }
  }, [deviceId, isNew, reloadKey])

  const users = (data && data.users) || []
  // Reporta el total al padre para el badge numérico de la pestaña.
  useEffect(() => { if (data && typeof onCount === 'function') onCount(users.length) }, [data])
  const stats = useMemo(() => ({
    card: users.filter((u) => u.card).length,
    pin: users.filter((u) => u.pin).length,
    face: users.filter((u) => u.face).length,
  }), [users])
  const filtered = useMemo(() => {
    const n = q.trim().toLowerCase()
    const base = users.filter((u) => {
      if (only === 'card' && !u.card) return false
      if (only === 'pin' && !u.pin) return false
      if (only === 'face' && !u.face) return false
      return !n || `${u.name} ${u.card} ${u.group} ${u.userId} ${u.phone}`.toLowerCase().includes(n)
    })
    // Los usuarios con datos (rostro > tarjeta > PIN) primero, para que no parezca
    // que "está todo vacío" cuando los primeros del equipo no tienen credenciales.
    const score = (u) => (u.face ? 4 : 0) + (u.card ? 2 : 0) + (u.pin ? 1 : 0)
    return base.slice().sort((a, b) => score(b) - score(a))
  }, [users, q, only])
  useEffect(() => { setPage(0) }, [q, reloadKey, only])
  const pages = Math.max(1, Math.ceil(filtered.length / PER))
  const ps = Math.min(page, pages - 1)
  const slice = filtered.slice(ps * PER, ps * PER + PER)

  const blank = { name: '', card: '', pin: '', group: '' }
  const openAdd = () => { setMsg(null); setEdit({ ...blank }) }
  const openEdit = (u) => { setMsg(null); setEdit({ userId: u.userId, name: u.name, card: u.card, pin: u.pin, group: u.group }) }
  const submit = async () => {
    if (!edit || !edit.name.trim()) { setMsg({ tone: 'err', text: 'El nombre es obligatorio.' }); return }
    setBusy(true); setMsg(null)
    try {
      const r = await fetch(`/api/device/${deviceId}/akuvox-user`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: edit.userId, name: edit.name, card: edit.card, pin: edit.pin, group: edit.group }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || !j.ok) throw new Error(j.message || j.error || `HTTP ${r.status}`)
      setEdit(null); setMsg({ tone: 'ok', text: edit.userId ? 'Usuario actualizado.' : 'Usuario creado.' })
      setReloadKey((k) => k + 1)
    } catch (e) { setMsg({ tone: 'err', text: `No se pudo guardar: ${e.message}` }) }
    finally { setBusy(false) }
  }
  const remove = async (u) => {
    if (!u.userId) return
    if (!window.confirm(`¿Borrar a «${u.name || u.userId}» del portero? Esta acción quita sus credenciales del equipo.`)) return
    setBusy(true); setMsg(null)
    try {
      const r = await fetch(`/api/device/${deviceId}/akuvox-user/${encodeURIComponent(u.userId)}`, { method: 'DELETE' })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || !j.ok) throw new Error(j.message || j.error || `HTTP ${r.status}`)
      setMsg({ tone: 'ok', text: 'Usuario borrado.' }); setReloadKey((k) => k + 1)
    } catch (e) { setMsg({ tone: 'err', text: `No se pudo borrar: ${e.message}` }) }
    finally { setBusy(false) }
  }
  const faceUrl = (u) => `/api/device/${deviceId}/akuvox-face?url=${encodeURIComponent(u.face)}`

  if (isNew) return <p className="help-block">Guardá el portero para leer sus usuarios.</p>
  if (data === undefined) return <div className="admin-center"><Spinner size={20} /><span>Leyendo usuarios del portero…</span></div>

  return (
    <div className="akusers">
      <div className="devlogs__bar">
        <span className="devlogs__count">
          <Icon name="operators" size={14} /> {filtered.length} de {users.length} usuarios
          <button type="button" className={`akusers__stat ${only === 'card' ? 'is-on' : ''}`} onClick={() => setOnly(only === 'card' ? 'all' : 'card')} title="Ver solo con tarjeta"><Icon name="route" size={12} /> {stats.card} tarjeta</button>
          <button type="button" className={`akusers__stat ${only === 'pin' ? 'is-on' : ''}`} onClick={() => setOnly(only === 'pin' ? 'all' : 'pin')} title="Ver solo con PIN"><Icon name="pin" size={12} /> {stats.pin} PIN</button>
          <button type="button" className={`akusers__stat ${only === 'face' ? 'is-on' : ''}`} onClick={() => setOnly(only === 'face' ? 'all' : 'face')} title="Ver solo con rostro"><Icon name="face" size={12} /> {stats.face} rostro</button>
        </span>
        <span className="devlogs__spacer" />
        <div className="devlogs__search">
          <Icon name="search" size={14} />
          <TextInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar usuario / tarjeta…" />
          {q && <button type="button" className="devlogs__clear" onClick={() => setQ('')} aria-label="Limpiar"><Icon name="x" size={13} /></button>}
        </div>
        <Button variant="ghost" size="sm" onClick={() => setReveal((v) => !v)}>{reveal ? 'Ocultar PIN' : 'Ver PIN'}</Button>
        <Button variant="ghost" size="sm" icon="refresh" onClick={() => setReloadKey((k) => k + 1)}>Actualizar</Button>
        <Button variant="primary" size="sm" icon="plus" onClick={openAdd}>Agregar usuario</Button>
      </div>

      {msg && <p className={`help-block ${msg.tone === 'err' ? 'devlogs__err' : 'akusers__ok'}`}><Icon name={msg.tone === 'err' ? 'alert' : 'check'} size={13} /> {msg.text}</p>}

      {edit && (
        <div className="akuform">
          <div className="akuform__hd"><Icon name={edit.userId ? 'edit' : 'plus'} size={14} /> {edit.userId ? `Editar usuario #${edit.userId}` : 'Nuevo usuario en el portero'}</div>
          <div className="akuform__grid">
            <label className="akuform__f"><span>Nombre</span><TextInput value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} placeholder="Ej: 101 · Juan Pérez" autoFocus /></label>
            <label className="akuform__f"><span>Tarjeta (código)</span><TextInput value={edit.card} onChange={(e) => setEdit({ ...edit, card: e.target.value })} placeholder="Ej: 00B4161D" /></label>
            <label className="akuform__f"><span>PIN privado</span><TextInput value={edit.pin} onChange={(e) => setEdit({ ...edit, pin: e.target.value })} placeholder="Ej: 4821" /></label>
            <label className="akuform__f"><span>Grupo / piso</span><TextInput value={edit.group} onChange={(e) => setEdit({ ...edit, group: e.target.value })} placeholder="Opcional" /></label>
          </div>
          <div className="akuform__actions">
            <Button variant="ghost" size="sm" onClick={() => setEdit(null)} disabled={busy}>Cancelar</Button>
            <Button variant="primary" size="sm" icon={busy ? undefined : 'check'} onClick={submit} disabled={busy}>{busy ? <Spinner size={14} /> : (edit.userId ? 'Guardar cambios' : 'Crear usuario')}</Button>
          </div>
          <p className="help-block akuform__note">Se escribe en el equipo por su HTTP API. Es una operación de configuración: <b>no abre puertas ni acciona relés</b>.</p>
        </div>
      )}

      {data.error && <p className="help-block devlogs__err"><Icon name="alert" size={13} /> No se pudieron leer los usuarios del portero. Revisá que el HTTP API esté habilitado y las credenciales.</p>}

      {stats.face === 0 && users.length > 0 && !data.error && (
        <p className="help-block akusers__facenote"><Icon name="face" size={13} /> Este portero no expone los rostros por su API (el firmware responde «sin handler») o no tiene rostros cargados. Tarjeta, PIN y grupo se leen normal; cuando un usuario sí tenga rostro, aparece su miniatura en la fila.</p>
      )}

      {filtered.length === 0 ? (
        <p className="help-block">{users.length === 0 ? 'El portero no tiene usuarios cargados (o el HTTP API no respondió).' : 'Ningún usuario coincide con la búsqueda.'}</p>
      ) : (
        <>
          <table className="akutable">
            <thead>
              <tr><th></th><th>Nombre</th><th>Tarjeta</th><th>PIN</th><th>Grupo</th><th>Rostro</th><th></th></tr>
            </thead>
            <tbody>
              {slice.map((u) => (
                <tr key={u.userId || u.name}>
                  <td className="akutable__face">
                    {u.face
                      ? <button type="button" className="akutable__facebtn" title="Ampliar rostro" onClick={() => setZoom(faceUrl(u))}>
                          <img src={faceUrl(u)} alt="" loading="lazy" onError={(e) => { const b = e.currentTarget.parentElement; if (b) b.outerHTML = '<span class="akutable__noface" title="Sin rostro (no cargó)"></span>' }} />
                        </button>
                      : <span className="akutable__noface" title="Sin rostro"><Icon name="operators" size={15} /></span>}
                  </td>
                  <td className="akutable__name">{u.name || '—'} <span className="akutable__uid">#{u.userId}</span></td>
                  <td>{u.card ? <Badge tone="accent">{u.card}</Badge> : <span className="muted">—</span>}</td>
                  <td className="tnum">{u.pin ? (reveal ? u.pin : '••••') : <span className="muted">—</span>}</td>
                  <td>{u.group || '—'}</td>
                  <td>{u.face ? <Badge tone="ok">sí</Badge> : <span className="muted">—</span>}</td>
                  <td className="akutable__act">
                    <button type="button" className="akutable__btn" title="Editar" onClick={() => openEdit(u)} disabled={busy}><Icon name="edit" size={14} /></button>
                    <button type="button" className="akutable__btn akutable__btn--del" title="Borrar del portero" onClick={() => remove(u)} disabled={busy}><Icon name="trash" size={14} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {pages > 1 && (
            <div className="devlogs__pager">
              <Button variant="ghost" size="sm" icon="chevron-left" disabled={ps === 0} onClick={() => setPage(ps - 1)}>Anterior</Button>
              <span className="devlogs__pageinfo tnum">Página {ps + 1} / {pages}</span>
              <Button variant="ghost" size="sm" disabled={ps >= pages - 1} onClick={() => setPage(ps + 1)}>Siguiente</Button>
            </div>
          )}
        </>
      )}

      {zoom && (
        <div className="akuzoom" onClick={() => setZoom(null)} role="dialog" aria-label="Rostro ampliado">
          <img className="akuzoom__img" src={zoom} alt="Rostro del usuario" onClick={(e) => e.stopPropagation()} />
        </div>
      )}
    </div>
  )
}
