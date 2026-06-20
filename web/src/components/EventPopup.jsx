import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Procedures from './Procedures.jsx'
import CameraWall from './CameraWall.jsx'
import NvrPlayback from './NvrPlayback.jsx'
import ClientPanel from './ClientPanel.jsx'
import { useCameraAnalytics, AnalyticsOverlay } from './CameraLive.jsx'
import { fetchProcedure, getProcedureFallback } from '../lib/procedures.js'
import { Badge, Button, Icon, PriorityDot, Segmented, Select, TextInput } from '../ui/primitives.jsx'
import {
  CATEGORY_LABEL,
  LOG_ACTION_LABEL,
  PRIORITY_LABEL,
  STATUS_LABEL,
  formatTime,
  priorityClass,
  slaInfo,
  sourceLine,
  timeAgo,
} from '../lib/format.js'
import { targetLabel, TARGET_ICON, TARGET_TONE } from '../lib/labels.js'

// Centro de Verificación en Vivo — modal SOC de gran formato (modal--xl).
// Izquierda (~66%): muro de video multi-cámara (CameraWall). Derecha (~34%):
// operación — cabecera del evento, metadata de la fuente, checklist del
// procedimiento (Procedures), botones de acción + nota, y la bitácora en vivo.
// TODA la lógica de socket (claim/ack/progress/note/escalate/resolve), la carga
// de procedimientos, el cierre con Escape y los props quedan intactos.

const STATUS_TONE = {
  new: 'accent',
  assigned: 'accent',
  ack: 'warn',
  in_progress: 'warn',
  resolved: 'ok',
  escalated: 'crit',
}

// Vista de EVIDENCIA: la foto del momento del evento (JPEG que el NVR adjunta en
// el cruce de línea / intrusión, guardada en event.media.evidenceUrl/snapshotUrl).
function EvidenceView({ event, url }) {
  const target = event && event.target
  const deviceId = event && event.source && event.source.deviceId
  const stageRef = useRef(null)
  const imgRef = useRef(null)
  const [box, setBox] = useState(null)
  const ana = useCameraAnalytics(deviceId, !!deviceId)
  const rules = ana && ana.rules && ana.rules.length ? ana.rules : null
  const recompute = () => {
    const st = stageRef.current, im = imgRef.current
    if (!st || !im || !im.naturalWidth) return
    const sr = st.getBoundingClientRect(), ir = im.getBoundingClientRect()
    const scale = Math.min(ir.width / im.naturalWidth, ir.height / im.naturalHeight)
    const pw = im.naturalWidth * scale, ph = im.naturalHeight * scale
    setBox({ left: (ir.left - sr.left) + (ir.width - pw) / 2, top: (ir.top - sr.top) + (ir.height - ph) / 2, width: pw, height: ph })
  }
  useEffect(() => {
    recompute()
    const st = stageRef.current
    if (!st || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => recompute()); ro.observe(st)
    return () => ro.disconnect()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [box && box.width ? null : 0])
  const [imgs, setImgs] = useState(null)
  const [idx, setIdx] = useState(0)
  const [busy, setBusy] = useState(false)
  const reload = () => fetch(`/api/events/${event.id}/evidence`).then((r) => r.json()).then((d) => setImgs(Array.isArray(d.images) ? d.images : [])).catch(() => setImgs([]))
  useEffect(() => { reload() }, [event && event.id])
  const gallery = (imgs && imgs.length) ? imgs : (url ? [{ url, ts: event && event.ts ? new Date(event.ts).getTime() : 0 }] : [])
  const cur = Math.min(idx, Math.max(0, gallery.length - 1))
  const main = gallery.length ? gallery[cur].url : null
  const capture = async () => {
    if (!deviceId || busy) return
    setBusy(true)
    try { const r = await fetch(`/api/events/${event.id}/evidence/capture`, { method: 'POST' }); if (r.ok) { await reload(); setIdx(999) } } finally { setBusy(false) }
  }
  if (!main) {
    return (
      <div className="evidence">
        <div className="evidence__empty">
          <Icon name="camera" size={30} />
          <span>Sin foto de evidencia para este evento.</span>
          <small>Las alarmas de cruce de línea / intrusión del NVR adjuntan la foto; otros tipos no la traen.</small>
          {deviceId && <button type="button" className="evidence__act" onClick={capture} disabled={busy}><Icon name="camera" size={13} /> {busy ? 'Capturando…' : 'Capturar ahora'}</button>}
        </div>
      </div>
    )
  }
  return (
    <div className="evidence" ref={stageRef}>
      <img ref={imgRef} className="evidence__img" src={main} alt="Foto de evidencia del evento" onLoad={recompute} />
      {rules && box && (
        <div className="evidence__anabox" style={{ left: box.left, top: box.top, width: box.width, height: box.height }}>
          <AnalyticsOverlay rules={rules} space={(ana && ana.space) || 1000} />
        </div>
      )}
      {gallery.length > 1 && (
        <div className="evidence__thumbs">
          {gallery.map((g, i) => (
            <button key={g.url} type="button" className={`evidence__thumb${i === cur ? ' is-on' : ''}`} onClick={() => setIdx(i)}>
              <img src={g.url} alt="" loading="lazy" />
            </button>
          ))}
        </div>
      )}
      <div className="evidence__cap">
        <span className="evidence__tag"><Icon name="camera" size={13} /> Fotos del caso ({gallery.length})</span>
        {target && target !== 'none' && (
          <span className="evidence__target"><Icon name={TARGET_ICON[target] || 'tag'} size={13} /> {targetLabel(target)}</span>
        )}
        {rules && <span className="evidence__anatag"><Icon name="filter" size={12} /> {rules.length} analítica{rules.length === 1 ? '' : 's'}</span>}
        {event && event.ts && <span className="evidence__time tnum">{formatTime(event.ts)}</span>}
        <span className="evidence__cap-spacer" />
        {deviceId && <button type="button" className="evidence__act evidence__act--cap" onClick={capture} disabled={busy}><Icon name="camera" size={13} /> {busy ? 'Capturando…' : 'Capturar'}</button>}
        <a className="evidence__act" href={main} download={`evidencia-${event.id}.jpg`}><Icon name="expand" size={13} /> Descargar</a>
      </div>
    </div>
  )
}

export default function EventPopup({ event, operator, actions, onClose }) {
  const [procedure, setProcedure] = useState(() =>
    getProcedureFallback(event && event.procedureId)
  )
  const [note, setNote] = useState('')
  const [groups, setGroups] = useState([])
  const [groupSel, setGroupSel] = useState('')
  const evidenceUrl = (event && event.media && (event.media.evidenceUrl || event.media.snapshotUrl)) || null
  // ¿El evento viene de una cámara? Las centrales de alarma NO (su deviceId es el
  // panel) → sin pestañas de vivo/grabación, solo evidencia.
  const hasCamera = !!(event && event.source && event.source.type && event.source.type !== 'alarm')
  // Vista del área de video: 'evidence' (foto del evento) | 'live' | 'rec'.
  // Sin cámara, siempre Evidencia (mensaje claro en vez de "Sin fuente de video").
  const [mode, setMode] = useState(evidenceUrl ? 'evidence' : (hasCamera ? 'live' : 'evidence'))
  const [, setTick] = useState(0) // re-render 1s para el contador de SLA

  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [])

  // Grupos disponibles para transferir (endpoint público de solo lectura).
  useEffect(() => {
    let alive = true
    fetch('/api/groups')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive && d && Array.isArray(d.groups)) setGroups(d.groups) })
      .catch(() => {})
    return () => { alive = false }
  }, [])

  // Cargar el procedimiento del evento (server o fallback) cuando cambia.
  useEffect(() => {
    let alive = true
    setProcedure(getProcedureFallback(event && event.procedureId))
    if (event && event.procedureId) {
      fetchProcedure(event.procedureId).then((p) => {
        if (alive && p) setProcedure(p)
      })
    }
    return () => {
      alive = false
    }
  }, [event && event.id, event && event.procedureId])

  // Atajos de teclado para acción ÁGIL (foco en procesar rápido): Esc cierra,
  // T=Tomar, A=Acuse, P=En curso, E=Escalar. Se ignoran si el foco está en un
  // campo de texto (para escribir notas sin disparar acciones).
  const kbd = useRef({})
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') { onClose(); return }
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const el = document.activeElement
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      const k = kbd.current
      if (!k || !k.actions) return
      const key = (e.key || '').toLowerCase()
      const note = ((k.getNote && k.getNote()) || '').trim() || undefined
      if (key === 't' && !k.closed && !k.mine && !k.assignedToOther) { e.preventDefault(); k.actions.claim(k.id) }
      else if (key === 'a' && !k.closed) { e.preventDefault(); k.actions.ack(k.id) }
      else if (key === 'p' && !k.closed) { e.preventDefault(); k.actions.progress(k.id, note) }
      else if (key === 'e' && !k.closed) { e.preventDefault(); k.actions.escalate(k.id, note) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  if (!event) return null

  const pc = priorityClass(event.priority)
  const p = event.priority ?? 5
  const mine = event.assignedTo && operator && event.assignedTo === operator.operatorId
  const assignedToOther = !!event.assignedTo && !mine
  const closed = event.status === 'resolved' // los escalados SÍ se pueden atender/resolver
  kbd.current = { actions, id: event.id, mine, assignedToOther, closed, getNote: () => note }

  function sendNote() {
    const text = note.trim()
    if (!text) return
    actions.note(event.id, text)
    setNote('')
  }

  return createPortal(
    // El clic fuera NO cierra el Centro de Verificación: solo la cruz (o Escape).
    <div className="modal-scrim">
      <div
        className="glass glass--strong modal modal--xl evpopup"
        style={{ '--accent-prio': `var(--${pc})` }}
        role="dialog"
        aria-modal="true"
        aria-label="Centro de Verificación en Vivo"
      >
        <header className="evpopup__head">
          <span className="evpopup__brand">
            <Icon name="video" size={17} />
            Centro de Verificación en Vivo
          </span>
          <span className="evpopup__head-spacer" />
          <span className="evpopup__time tnum">{timeAgo(event.ts)}</span>
          <button
            className="icon-btn icon-btn--md btn--ghost"
            onClick={onClose}
            aria-label="Cerrar"
          >
            <Icon name="x" size={18} />
          </button>
        </header>

        <div className="evpopup__body">
          {/* IZQUIERDA — Muro de video (o playback del NVR) */}
          <div className="evpopup__wall">
            <div className="evpopup__walltabs">
              <Segmented value={mode} onChange={setMode} options={[
                { value: 'evidence', label: 'Evidencia' },
                ...(hasCamera ? [{ value: 'live', label: 'En vivo' }, { value: 'rec', label: 'Grabación' }] : []),
              ]} />
            </div>
            {mode === 'rec'
              ? <NvrPlayback event={event} onClose={() => setMode('live')} />
              : mode === 'evidence'
                ? <EvidenceView event={event} url={evidenceUrl} />
                : <CameraWall event={event} />}
          </div>

          {/* DERECHA — Operación */}
          <div className="evpopup__op">
            <div className="evpopup__evhead">
              <span className="evpopup__prio" style={{ color: `var(--${pc})` }}>
                <PriorityDot p={p} size={14} />
                <span className="tnum">P{p}</span>
                <span className="evpopup__prio-lbl">
                  {PRIORITY_LABEL[event.priority] || 'Info'}
                </span>
              </span>
              <Badge tone={STATUS_TONE[event.status] || 'neutral'}>
                {STATUS_LABEL[event.status] || event.status}
              </Badge>
              {(() => { const s = slaInfo(event); return s ? <span className={`evpopup__sla evpopup__sla--${s.tone}`}><Icon name="clock" size={13} /> {s.label}</span> : null })()}
              {event.target && event.target !== 'none' && (
                <Badge tone={TARGET_TONE[event.target] || 'neutral'}>
                  <Icon name={TARGET_ICON[event.target] || 'dot'} size={12} /> {targetLabel(event.target)}
                </Badge>
              )}
            </div>

            <h2 className="evpopup__title">{event.title || event.type}</h2>
            <div className="evpopup__subrow">
              <span className="evpopup__cat">
                {CATEGORY_LABEL[event.category] || event.category}
              </span>
              <span className="evpopup__dotsep" aria-hidden="true">·</span>
              <span className="evpopup__src">{sourceLine(event)}</span>
            </div>
            {event.message ? (
              <p className="evpopup__message">{event.message}</p>
            ) : null}

            {/* CLIENTE · RESPUESTA arriba: lo PRIMERO que el operador necesita
                (a quién llamar, protocolo, dirección) en un evento. */}
            <ClientPanel event={event} actions={actions} critical={p <= 2} />

            <p className="evpopup__sec-lbl"><Icon name="bolt" size={13} /> Gestión del evento
              <span className="evpopup__kbdhint" title="Atajos: T Tomar · A Acuse · P En curso · E Escalar · Esc Cerrar"><b>T</b><b>A</b><b>P</b><b>E</b></span>
            </p>
            <div className={`evpopup__actions${(!mine && !assignedToOther && !closed) ? ' evpopup__actions--take' : ''}`}>
              <Button
                variant="primary"
                icon="check"
                className="evpopup__take"
                disabled={closed || mine || assignedToOther}
                onClick={() => actions.claim(event.id)}
              >
                {mine ? 'Tomado' : assignedToOther ? 'Tomado por otro' : 'Tomar'}
              </Button>
              <Button variant="secondary" disabled={closed} onClick={() => actions.ack(event.id)}>
                Acuse
              </Button>
              <Button
                variant="secondary"
                disabled={closed}
                onClick={() => actions.progress(event.id, note.trim() || undefined)}
              >
                En curso
              </Button>
              <Button
                variant="danger"
                icon="alert"
                disabled={closed}
                onClick={() => actions.escalate(event.id, note.trim() || undefined)}
              >
                Escalar
              </Button>
            </div>

            <div className="evpopup__noterow">
              <TextInput
                type="text"
                placeholder="Añadir nota a la bitácora…"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && sendNote()}
                disabled={closed}
              />
              <Button variant="secondary" onClick={sendNote} disabled={closed || !note.trim()}>
                Nota
              </Button>
            </div>

            {groups.length > 0 && (
              <div className="evpopup__transfer">
                <span className="evpopup__sec-lbl"><Icon name="shieldcheck" size={13} /> Transferir a grupo</span>
                <div className="evpopup__transfer-row">
                  <Select value={groupSel} onChange={(e) => setGroupSel(e.target.value)} disabled={closed}>
                    <option value="">— Elegir grupo —</option>
                    {groups.map((g) => <option key={g.id} value={g.id}>{g.name} · {g.memberCount} op.</option>)}
                  </Select>
                  <Button variant="secondary" icon="route" disabled={closed || !groupSel}
                    onClick={() => { actions.transfer(event.id, groupSel); setGroupSel(''); onClose() }}>
                    Transferir
                  </Button>
                </div>
              </div>
            )}

            <Procedures
              procedure={procedure}
              eventId={event.id}
              onStepNote={(text) => actions.note(event.id, text)}
              onResolve={(disposition, closeNote) =>
                actions.resolve(event.id, disposition, closeNote || undefined)
              }
            />

            <details className="evpopup__tech">
              <summary className="evpopup__tech-sum">
                <Icon name="device" size={13} /> Detalles técnicos del evento
                <Icon name="chevron" size={14} className="evpopup__tech-chev" />
              </summary>
              <dl className="evpopup__meta">
                <Meta label="Tipo" value={event.type} />
                <Meta label="Vendor" value={(event.source && event.source.vendor) || '—'} />
                <Meta label="IP" value={(event.source && event.source.ip) || '—'} />
                <Meta
                  label="Zona"
                  value={event.zone || (event.source && event.source.site) || '—'}
                />
                <Meta label="Recibido" value={`${formatTime(event.ts)} (${timeAgo(event.ts)})`} />
                {event.deviceTs ? (
                  <Meta label="Dispositivo" value={formatTime(event.deviceTs)} />
                ) : null}
              </dl>
            </details>

            <div className="bitacora">
              <h4 className="bitacora__title">
                <Icon name="rules" size={15} /> Bitácora
              </h4>
              <ul className="bitacora__list">
                {(event.log || [])
                  .slice()
                  .reverse()
                  .map((l, i) => (
                    <li key={i} className="bitacora__item">
                      <span className="bitacora__dot" aria-hidden="true" />
                      <span className="bitacora__time tnum">{formatTime(l.ts)}</span>
                      <span className={`bitacora__act bitacora__act--${l.action}`}>
                        {LOG_ACTION_LABEL[l.action] || l.action}
                      </span>
                      <span className="bitacora__who">
                        {l.operatorName || l.operatorId || 'sistema'}
                      </span>
                      {l.note ? <span className="bitacora__note">{l.note}</span> : null}
                    </li>
                  ))}
                {(event.log || []).length === 0 ? (
                  <li className="bitacora__item bitacora__item--empty">Sin actividad.</li>
                ) : null}
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

function Meta({ label, value }) {
  return (
    <div className="evpopup__meta-item">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}
