// DeviceLogs — pestaña "Logs" de un dispositivo. Fusiona el registro NATIVO del
// equipo (Akuvox: aperturas/llamadas; Hik: excepciones/operaciones) con los
// eventos de EventOS de ese dispositivo. Buscador + filtros + paginación para no
// renderizar todo de una. El registro nativo se cachea en el server (~60s).
import { useEffect, useMemo, useState } from 'react'
import { Icon, Spinner, Button, Badge, TextInput } from '../ui/primitives.jsx'
import { formatTime, timeAgo } from '../lib/format.js'

const KIND = {
  door:  { icon: 'route', tone: 'ok',     label: 'Apertura' },
  call:  { icon: 'phone', tone: 'accent', label: 'Llamada' },
  event: { icon: 'bell',  tone: 'warn',   label: 'Evento' },
  alarm:     { icon: 'bell',  tone: 'warn',   label: 'Alarma' },
  motion:    { icon: 'video', tone: 'warn',   label: 'Movimiento' },
  system:    { icon: 'rules', tone: 'accent', label: 'Sistema' },
  operation: { icon: 'route', tone: 'accent', label: 'Operación' },
  exception: { icon: 'alert', tone: 'warn',   label: 'Excepción' },
}
const okStatus = (s) => /succ|éxito|exito|ok|received|dial/i.test(String(s || ''))
const PER_PAGE = 25

export default function DeviceLogs({ device, isNew, onCount }) {
  const [data, setData] = useState(undefined)
  const [reloadKey, setReloadKey] = useState(0)
  const [q, setQ] = useState('')
  const [kind, setKind] = useState('all')     // 'all' | kind
  const [source, setSource] = useState('all') // 'all' | 'device' | 'eventos'
  const [page, setPage] = useState(0)

  useEffect(() => {
    if (isNew || !device || !device.id) return
    let alive = true
    setData(undefined)
    fetch(`/api/device/${device.id}/logs?limit=300`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive) setData(d || { entries: [] }) })
      .catch(() => { if (alive) setData({ entries: [] }) })
    return () => { alive = false }
  }, [device && device.id, isNew, reloadKey])

  const entries = (data && data.entries) || []
  // Reporta el total al padre para el badge numérico de la pestaña.
  useEffect(() => { if (data && typeof onCount === 'function') onCount(entries.length) }, [data])

  // Tipos presentes (para las chips de filtro), con conteo.
  const kindsPresent = useMemo(() => {
    const m = new Map()
    for (const e of entries) m.set(e.kind, (m.get(e.kind) || 0) + 1)
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [entries])

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return entries.filter((e) => {
      if (kind !== 'all' && e.kind !== kind) return false
      if (source !== 'all' && e.source !== source) return false
      if (needle) {
        const hay = `${e.title || ''} ${e.detail || ''} ${e.status || ''} ${e.type || ''}`.toLowerCase()
        if (!hay.includes(needle)) return false
      }
      return true
    })
  }, [entries, q, kind, source])

  // Reset de página al cambiar filtros.
  useEffect(() => { setPage(0) }, [q, kind, source, reloadKey])

  const pages = Math.max(1, Math.ceil(filtered.length / PER_PAGE))
  const pageSafe = Math.min(page, pages - 1)
  const slice = filtered.slice(pageSafe * PER_PAGE, pageSafe * PER_PAGE + PER_PAGE)

  if (isNew) return <p className="help-block">Guardá el dispositivo para ver su registro.</p>
  if (data === undefined) return (
    <div className="devlogs devlogs--wrap">
      <div className="devlogs__loading">
        <span className="devlogs__loading-lbl"><Spinner size={15} /> Leyendo el registro del equipo…</span>
        <ul className="devlogs__list devlogs__skel" aria-hidden="true">
          {Array.from({ length: 8 }).map((_, i) => (
            <li key={i} className="devlog devlog--skel" style={{ animationDelay: `${i * 70}ms` }}>
              <span className="sk sk--ic" />
              <span className="sk sk--time" />
              <span className="sk sk--title" style={{ width: `${38 + ((i * 13) % 34)}%` }} />
              <span className="devlog__spacer" />
              <span className="sk sk--src" />
              <span className="sk sk--ago" />
            </li>
          ))}
        </ul>
      </div>
    </div>
  )

  return (
    <div className="devlogs devlogs--wrap">
      <div className="devlogs__bar">
        <span className="devlogs__count"><Icon name="rules" size={14} /> {filtered.length} de {entries.length} {data.native ? '· equipo + eventos' : '· eventos EventOS'}</span>
        <span className="devlogs__spacer" />
        <div className="devlogs__search">
          <Icon name="search" size={14} />
          <TextInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar en el registro…" />
          {q && <button type="button" className="devlogs__clear" onClick={() => setQ('')} aria-label="Limpiar"><Icon name="x" size={13} /></button>}
        </div>
        <Button variant="ghost" size="sm" icon="refresh" onClick={() => setReloadKey((k) => k + 1)}>Actualizar</Button>
      </div>

      {(kindsPresent.length > 1 || data.native) && (
        <div className="devlogs__filters">
          <button type="button" className={`chip ${kind === 'all' ? 'is-on' : ''}`} onClick={() => setKind('all')}>Todo</button>
          {kindsPresent.map(([k, n]) => {
            const meta = KIND[k] || KIND.event
            return (
              <button type="button" key={k} className={`chip ${kind === k ? 'is-on' : ''} t-${meta.tone}`} onClick={() => setKind(kind === k ? 'all' : k)}>
                <Icon name={meta.icon} size={12} /> {meta.label} <span className="chip__n">{n}</span>
              </button>
            )
          })}
          <span className="devlogs__spacer" />
          <select className="input devlogs__src-sel" value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="all">Toda fuente</option>
            <option value="device">Equipo</option>
            <option value="eventos">EventOS</option>
          </select>
        </div>
      )}

      {data.error && <p className="help-block devlogs__err"><Icon name="alert" size={13} /> No se pudo leer el registro nativo del equipo: {data.error}</p>}

      {filtered.length === 0 ? (
        <p className="help-block">{entries.length === 0 ? 'Sin registros para este dispositivo todavía.' : 'Ningún registro coincide con el filtro.'}</p>
      ) : (
        <>
          <ul className="devlogs__list">
            {slice.map((e, i) => {
              const k = KIND[e.kind] || KIND.event
              return (
                <li key={pageSafe * PER_PAGE + i} className={`devlog devlog--${e.source}`}>
                  <span className={`devlog__ic t-${k.tone}`}><Icon name={k.icon} size={14} /></span>
                  <span className="devlog__time tnum">{formatTime(e.ts)}</span>
                  <span className="devlog__title">{e.title || k.label}</span>
                  {e.status ? <Badge tone={okStatus(e.status) ? 'ok' : 'crit'}>{e.status}</Badge> : null}
                  {e.detail ? <span className="devlog__detail">{e.detail}</span> : null}
                  <span className="devlog__spacer" />
                  <span className={`devlog__src devlog__src--${e.source}`}>{e.source === 'device' ? 'equipo' : 'EventOS'}</span>
                  <span className="devlog__ago tnum">{timeAgo(e.ts)}</span>
                </li>
              )
            })}
          </ul>
          {pages > 1 && (
            <div className="devlogs__pager">
              <Button variant="ghost" size="sm" icon="chevron-left" disabled={pageSafe === 0} onClick={() => setPage(pageSafe - 1)}>Anterior</Button>
              <span className="devlogs__pageinfo tnum">Página {pageSafe + 1} / {pages}</span>
              <Button variant="ghost" size="sm" disabled={pageSafe >= pages - 1} onClick={() => setPage(pageSafe + 1)}>Siguiente</Button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
