// AkuvoxUsers — lee y muestra TODO lo que el portero Akuvox tiene cargado por
// persona (SmartPlus user/get): nombre, tarjeta RFID, PIN privado y rostro. Con
// buscador, conteos y paginación. El rostro se sirve por proxy del server.
import { useEffect, useMemo, useState } from 'react'
import { Icon, Spinner, Button, Badge, TextInput } from '../ui/primitives.jsx'

const PER = 20

export default function AkuvoxUsers({ deviceId, isNew }) {
  const [data, setData] = useState(undefined)
  const [q, setQ] = useState('')
  const [page, setPage] = useState(0)
  const [reveal, setReveal] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)

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
  const stats = useMemo(() => ({
    card: users.filter((u) => u.card).length,
    pin: users.filter((u) => u.pin).length,
    face: users.filter((u) => u.face).length,
  }), [users])
  const filtered = useMemo(() => {
    const n = q.trim().toLowerCase()
    return users.filter((u) => !n || `${u.name} ${u.card} ${u.group} ${u.userId} ${u.phone}`.toLowerCase().includes(n))
  }, [users, q])
  useEffect(() => { setPage(0) }, [q, reloadKey])
  const pages = Math.max(1, Math.ceil(filtered.length / PER))
  const ps = Math.min(page, pages - 1)
  const slice = filtered.slice(ps * PER, ps * PER + PER)

  if (isNew) return <p className="help-block">Guardá el portero para leer sus usuarios.</p>
  if (data === undefined) return <div className="admin-center"><Spinner size={20} /><span>Leyendo usuarios del portero…</span></div>

  return (
    <div className="akusers">
      <div className="devlogs__bar">
        <span className="devlogs__count">
          <Icon name="operators" size={14} /> {filtered.length} de {users.length} usuarios
          <span className="akusers__stat"><Icon name="route" size={12} /> {stats.card} tarjeta</span>
          <span className="akusers__stat"><Icon name="lock" size={12} /> {stats.pin} PIN</span>
          <span className="akusers__stat"><Icon name="face" size={12} /> {stats.face} rostro</span>
        </span>
        <span className="devlogs__spacer" />
        <div className="devlogs__search">
          <Icon name="search" size={14} />
          <TextInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar usuario / tarjeta…" />
          {q && <button type="button" className="devlogs__clear" onClick={() => setQ('')} aria-label="Limpiar"><Icon name="x" size={13} /></button>}
        </div>
        <Button variant="ghost" size="sm" onClick={() => setReveal((v) => !v)}>{reveal ? 'Ocultar PIN' : 'Ver PIN'}</Button>
        <Button variant="ghost" size="sm" icon="refresh" onClick={() => setReloadKey((k) => k + 1)}>Actualizar</Button>
      </div>

      {data.error && <p className="help-block devlogs__err"><Icon name="alert" size={13} /> No se pudieron leer los usuarios del portero. Revisá que el HTTP API esté habilitado y las credenciales.</p>}

      {filtered.length === 0 ? (
        <p className="help-block">{users.length === 0 ? 'El portero no tiene usuarios cargados (o el HTTP API no respondió).' : 'Ningún usuario coincide con la búsqueda.'}</p>
      ) : (
        <>
          <table className="akutable">
            <thead>
              <tr><th></th><th>Nombre</th><th>Tarjeta</th><th>PIN</th><th>Grupo</th><th>Rostro</th></tr>
            </thead>
            <tbody>
              {slice.map((u) => (
                <tr key={u.userId || u.name}>
                  <td className="akutable__face">
                    {u.face
                      ? <img src={`/api/device/${deviceId}/akuvox-face?url=${encodeURIComponent(u.face)}`} alt="" loading="lazy" onError={(e) => { e.currentTarget.style.display = 'none' }} />
                      : <span className="akutable__noface"><Icon name="operators" size={15} /></span>}
                  </td>
                  <td className="akutable__name">{u.name || '—'} <span className="akutable__uid">#{u.userId}</span></td>
                  <td>{u.card ? <Badge tone="accent">{u.card}</Badge> : <span className="muted">—</span>}</td>
                  <td className="tnum">{u.pin ? (reveal ? u.pin : '••••') : <span className="muted">—</span>}</td>
                  <td>{u.group || '—'}</td>
                  <td>{u.face ? <Badge tone="ok">sí</Badge> : <span className="muted">—</span>}</td>
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
    </div>
  )
}
