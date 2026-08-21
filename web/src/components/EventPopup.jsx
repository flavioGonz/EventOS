import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Procedures from './Procedures.jsx'
import CameraWall from './CameraWall.jsx'
import NvrPlayback from './NvrPlayback.jsx'
import ClientPanel from './ClientPanel.jsx'
import { useCameraAnalytics, AnalyticsOverlay } from './CameraLive.jsx'
import { fetchProcedure, getProcedureFallback } from '../lib/procedures.js'
import { apiFetch } from '../lib/eventsApi.js'
import AccessReadBadge from './AccessReadBadge.jsx'
import { Badge, Button, Icon, PriorityDot, Segmented, Select, TextInput } from '../ui/primitives.jsx'
import {
  CATEGORY_LABEL,
  DISPOSITION_LABEL,
  LOG_ACTION_LABEL,
  PRIORITY_LABEL,
  STATUS_LABEL,
  formatTime,
  priorityClass,
  slaInfo,
  sourceLine,
  timeAgo,
} from '../lib/format.js'

// Disposiciones posibles al resolver un evento (mismo orden que el checklist).
const DISPOSITIONS = ['real', 'false_alarm', 'test', 'no_action']
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
  // El marco adopta la relación de aspecto REAL de la foto (igual que el visor en
  // vivo). Así la imagen no se deforma y el overlay de analíticas se dibuja sobre el
  // mismo cuadro que la cámara/NVR → sin corrimientos. Se enciende con el chip.
  const [aspect, setAspect] = useState(null)
  const [showAna, setShowAna] = useState(false)
  const ana = useCameraAnalytics(deviceId, !!deviceId)
  const rules = ana && ana.rules && ana.rules.length ? ana.rules : null
  const onImgLoad = (e) => { const im = e.currentTarget; if (im.naturalWidth && im.naturalHeight) setAspect(`${im.naturalWidth} / ${im.naturalHeight}`) }
  const [imgs, setImgs] = useState(null)
  const [idx, setIdx] = useState(0)
  const [busy, setBusy] = useState(false)
  const reload = () => apiFetch(`/api/events/${event.id}/evidence`).then((r) => r.json()).then((d) => setImgs(Array.isArray(d.images) ? d.images : [])).catch(() => setImgs([]))
  useEffect(() => { reload() }, [event && event.id])
  const gallery = (imgs && imgs.length) ? imgs : (url ? [{ url, ts: event && event.ts ? new Date(event.ts).getTime() : 0 }] : [])
  const cur = Math.min(idx, Math.max(0, gallery.length - 1))
  const main = gallery.length ? gallery[cur].url : null
  const capture = async () => {
    if (!deviceId || busy) return
    setBusy(true)
    try { const r = await apiFetch(`/api/events/${event.id}/evidence/capture`, { method: 'POST' }); if (r.ok) { await reload(); setIdx(999) } } finally { setBusy(false) }
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
    <div className={`evidence${rules && showAna ? ' evidence--ana' : ''}`}>
      <div className="evidence__stage">
        <div className="evidence__frame" style={aspect ? { aspectRatio: aspect } : undefined}>
          <img className="evidence__img" src={main} alt="Foto de evidencia del evento" onLoad={onImgLoad} />
          {rules && showAna && (
            <div className="evidence__anabox">
              <AnalyticsOverlay rules={rules} space={(ana && ana.space) || 1000} />
            </div>
          )}
        </div>
      </div>
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
        {rules && <button type="button" className={`evidence__anatag${showAna ? ' is-on' : ''}`} onClick={() => setShowAna((v) => !v)} title={showAna ? 'Ocultar analíticas dibujadas (pueden no coincidir con esta foto)' : 'Superponer las analíticas dibujadas de la cámara'}><Icon name="filter" size={12} /> {rules.length} analítica{rules.length === 1 ? '' : 's'}</button>}
        {event && event.ts && <span className="evidence__time"><Icon name="clock" size={12} /> <span className="tnum">{formatTime(event.ts)}</span></span>}
        <span className="evidence__cap-spacer" />
        {deviceId && <button type="button" className="evidence__act evidence__act--cap" onClick={capture} disabled={busy}><Icon name="camera" size={13} /> {busy ? 'Capturando…' : 'Capturar'}</button>}
        <a className="evidence__act" href={main} download={`evidencia-${event.id}.jpg`}><Icon name="expand" size={13} /> Descargar</a>
      </div>
    </div>
  )
}

export default function EventPopup({ event, operator, actions, onClose, supervise = false, queuePos = null, onNav = null }) {
  const [procedure, setProcedure] = useState(() =>
    getProcedureFallback(event && event.procedureId)
  )
  const [note, setNote] = useState('')
  const [disposition, setDisposition] = useState('')
  const [groups, setGroups] = useState([])
  const [groupSel, setGroupSel] = useState('')
  // Modo INTERVENCIÓN: se activa al confirmar la alarma como REAL. Cambia la
  // experiencia (banner + controles de disuasión foregrounded) sin cerrar el popup.
  const [intervene, setIntervene] = useState(false)
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
      if (supervise) return // supervisión = solo lectura, sin atajos de acción
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const el = document.activeElement
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      const k = kbd.current
      if (!k || !k.actions) return
      const key = (e.key || '').toLowerCase()
      const note = ((k.getNote && k.getNote()) || '').trim() || undefined
      if (key === 't' && !k.closed && !k.mine && !k.assignedToOther) { e.preventDefault(); k.actions.claim(k.id); k.actions.progress(k.id) }
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
        className={`glass glass--strong modal modal--xl evpopup${intervene ? ' evpopup--intervene' : ''}`}
        style={{ '--accent-prio': `var(--${pc})` }}
        role="dialog"
        aria-modal="true"
        aria-label="Centro de Verificación en Vivo"
      >
        {/* Navegación por la cola (‹ N/total ›): procesar eventos sin cerrar el modal. */}
        {queuePos && onNav && (
          <div className="evpopup__nav" role="group" aria-label="Navegar en la cola">
            <button type="button" onClick={() => onNav(-1)} disabled={queuePos.index <= 0} title="Anterior" aria-label="Anterior"><Icon name="chevronleft" size={16} /></button>
            <span className="evpopup__navpos tnum">{queuePos.index + 1}/{queuePos.total}</span>
            <button type="button" onClick={() => onNav(1)} disabled={queuePos.index >= queuePos.total - 1} title="Siguiente" aria-label="Siguiente"><Icon name="chevronright" size={16} /></button>
          </div>
        )}
        {/* Cierre FLOTANTE (sin barra de título): la ventana es el video mismo. */}
        <button
          className="evpopup__close"
          onClick={onClose}
          aria-label="Cerrar"
          title="Cerrar (Esc)"
        >
          <Icon name="x" size={16} />
        </button>

        {/* La columna de operación (der.) aparece SOLO en la tab Evidencia; en
            En vivo / Grabación el muro de video ocupa todo el ancho. */}
        <div className={`evpopup__body${(mode !== 'evidence' && !intervene) ? ' evpopup__body--wide' : ''}`}>
          {/* IZQUIERDA — Muro de video (o playback del NVR) */}
          <div className="evpopup__wall">
            {/* Badge efímero de lectura de acceso (portero del mismo cliente). Overlay
                DOM: no toca el video. Filtra por el sitio del evento. */}
            <AccessReadBadge siteName={event.source && event.source.site} />
            <div className="evpopup__tabs">
              <Segmented value={mode} onChange={setMode} options={[
                { value: 'evidence', label: 'Evidencia' },
                ...(hasCamera ? [{ value: 'live', label: 'En vivo' }, { value: 'rec', label: 'Grabación' }] : []),
              ]} />
            </div>
            {/* Panel con transición al cambiar de tab (fade + leve subida). */}
            <div className="evpopup__pane" key={mode}>
              {mode === 'rec'
                ? <NvrPlayback event={event} onClose={() => setMode('live')} />
                : mode === 'evidence'
                  ? <EvidenceView event={event} url={evidenceUrl} />
                  : <CameraWall event={event} />}
            </div>
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

            {/* MODO INTERVENCIÓN — al confirmar alarma real. Foregroundea disuasión:
                relés/sirena (muro de video) + parlantes SIP del cliente (abajo). */}
            {intervene && !supervise && (
              <div className="evintervene" role="alert">
                <div className="evintervene__hd">
                  <span className="evintervene__pulse" aria-hidden="true" />
                  <Icon name="alert" size={16} /> Alarma REAL confirmada · Intervención
                </div>
                <p className="evintervene__lead">Disuadí al intruso: accioná <b>sirena / relé</b> (en el panel de video) y <b>hablá por el parlante</b> del cliente. Todo queda en la bitácora.</p>
                <div className="evintervene__acts">
                  <a className="evintervene__act" href="#evpopup-relays"><Icon name="route" size={14} /> Ir a relés / sirena</a>
                  <a className="evintervene__act" href="#evpopup-speakers"><Icon name="phone" size={14} /> Parlantes SIP</a>
                  <button type="button" className="evintervene__done" onClick={() => { actions.resolve(event.id, 'real', note.trim() || undefined); onClose() }}>
                    <Icon name="check" size={14} /> Finalizar y resolver
                  </button>
                </div>
              </div>
            )}

            {/* CLIENTE · RESPUESTA arriba: lo PRIMERO que el operador necesita
                (a quién llamar, protocolo, dirección) en un evento. */}
            <div id="evpopup-speakers"><ClientPanel event={event} actions={actions} critical={p <= 2 || intervene} /></div>

            {/* Relés / puertas: ahora en la columna de operación (ya NO flotando a
                la derecha del video, donde chocaba con la columna Perímetro). */}
            {!supervise && <div id="evpopup-relays"><RelayBar deviceId={event.source && event.source.deviceId} closed={closed}
              operatorId={(operator && operator.id) || 'operator'} /></div>}

            {supervise && (
              <div className="evpopup__superbanner"><Icon name="gauge" size={14} /> Vista de supervisión · solo lectura, podés reasignar</div>
            )}

            {!supervise && (<>
            <p className="evpopup__sec-lbl"><Icon name="bolt" size={13} /> Gestión del evento
              <span className="evpopup__kbdhint" title="Atajos: T Tomar (pasa a en curso) · E Escalar · Esc Cerrar"><b>T</b><b>E</b></span>
            </p>
            {/* Acciones agrupadas: Tomar · Escalar · Alarma real · Falsa alarma.
                Resolver (real/falsa) cierra el popup y vuelve a la lista. */}
            <div className={`evpopup__actions${(!mine && !assignedToOther && !closed) ? ' evpopup__actions--take' : ''}`}>
              <Button
                variant="primary"
                icon="check"
                className="evpopup__take"
                data-tip="Te asignás el evento (queda a tu nombre) y pasa a EN CURSO · atajo T"
                disabled={closed || mine || assignedToOther}
                onClick={() => { actions.claim(event.id); actions.progress(event.id, note.trim() || undefined) }}
              >
                {mine ? 'En curso' : assignedToOther ? 'Tomado por otro' : 'Tomar'}
              </Button>
              <Button
                variant="danger"
                icon="alert"
                data-tip="Derivás el evento a supervisión / lo escalás · atajo E"
                disabled={closed}
                onClick={() => actions.escalate(event.id, note.trim() || undefined)}
              >
                Escalar
              </Button>
              <Button
                variant="secondary"
                icon="alert"
                className="evpopup__resolve evpopup__resolve--real"
                data-tip="Confirmar ALARMA REAL y pasar a modo intervención (disuasión / llamada)"
                disabled={closed || intervene}
                onClick={() => {
                  if (!mine && !assignedToOther) actions.claim(event.id)
                  actions.progress && actions.progress(event.id)
                  actions.note(event.id, 'Alarma confirmada REAL — intervención iniciada')
                  setIntervene(true)
                }}
              >
                {intervene ? 'En intervención' : 'Alarma real'}
              </Button>
              <Button
                variant="secondary"
                icon="check"
                className="evpopup__resolve evpopup__resolve--false"
                data-tip="Resolver como FALSA alarma y cerrar"
                disabled={closed}
                onClick={() => { actions.resolve(event.id, 'false_alarm', note.trim() || undefined); onClose() }}
              >
                Falsa alarma
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
              <Button variant="secondary" data-tip="Agregás una nota a la bitácora del evento" onClick={sendNote} disabled={closed || !note.trim()}>
                Nota
              </Button>
            </div>

            {/* Resolver con disposición — dentro de Gestión del evento. La nota de
                arriba se usa como nota de cierre. Al resolver, cierra el popup. */}
            <div className="evpopup__resolverow">
              <Select value={disposition} onChange={(e) => setDisposition(e.target.value)} disabled={closed}>
                <option value="">Disposición…</option>
                {DISPOSITIONS.map((d) => <option key={d} value={d}>{DISPOSITION_LABEL[d]}</option>)}
              </Select>
              <Button
                variant="danger"
                icon="check"
                className="evpopup__resolvebtn"
                data-tip={disposition ? 'Resolver el evento con la disposición elegida y cerrar' : 'Elegí una disposición para resolver'}
                disabled={closed || !disposition}
                onClick={() => { actions.resolve(event.id, disposition, note.trim() || undefined); onClose() }}
              >
                Resolver
              </Button>
            </div>
            </>)}

            {groups.length > 0 && (
              <div className="evpopup__transfer">
                <span className="evpopup__sec-lbl"><Icon name="shieldcheck" size={13} /> {supervise ? 'Reasignar a grupo' : 'Transferir a grupo'}</span>
                <div className="evpopup__transfer-row">
                  <Select value={groupSel} onChange={(e) => setGroupSel(e.target.value)} disabled={closed}>
                    <option value="">— Elegir grupo —</option>
                    {groups.map((g) => <option key={g.id} value={g.id}>{g.name} · {g.memberCount} op.</option>)}
                  </Select>
                  <Button variant="secondary" icon="route" data-tip={supervise ? 'Reasignás el evento al grupo de operarios elegido' : 'Transferís el evento al grupo de operarios elegido'} disabled={closed || !groupSel}
                    onClick={() => { actions.transfer(event.id, groupSel); setGroupSel(''); onClose() }}>
                    {supervise ? 'Reasignar' : 'Transferir'}
                  </Button>
                </div>
              </div>
            )}

            {!supervise && (
              <Procedures
                procedure={procedure}
                eventId={event.id}
                onStepNote={(text) => actions.note(event.id, text)}
              />
            )}

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

// RelayBar — control de puertas/relés como ICONOGRAFÍA: cada salida es un botón
// redondo (icono de puerta) que, al presionarse, se ANIMA y pide CONFIRMACIÓN
// inline (¿Abrir? ✓/✕) antes de accionar la salida física. Al confirmar, el
// botón pulsa en verde y muestra el check de "abierta". Nada se dispara sin ese
// segundo toque del operador — la acción física siempre es deliberada.
function RelayBar({ deviceId, closed, operatorId }) {
  const [outputs, setOutputs] = useState(null)
  const [busy, setBusy] = useState('')        // id accionándose
  const [confirmId, setConfirmId] = useState(null) // id esperando confirmación
  const [done, setDone] = useState('')        // id recién abierto (pulso verde)
  const [msg, setMsg] = useState(null)
  useEffect(() => {
    if (!deviceId) { setOutputs([]); return }
    let alive = true
    fetch(`/api/device/${deviceId}/outputs`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive) setOutputs(Array.isArray(d) ? d : (d && (d.outputs || d.relays)) || []) })
      .catch(() => { if (alive) setOutputs([]) })
    return () => { alive = false }
  }, [deviceId])
  if (!deviceId || !outputs || outputs.length === 0) return null

  const ask = (id) => { setMsg(null); setConfirmId(id) }
  const cancel = () => setConfirmId(null)

  const fire = async (o, id) => {
    setConfirmId(null); setBusy(id); setMsg(null)
    try {
      const res = await fetch(`/api/device/${deviceId}/relay`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ output: id, cmd: o.kind || 'open', confirmed: true, operatorId }),
      })
      const d = await res.json().catch(() => ({}))
      const ok = !!(d && d.ok)
      if (ok) { setDone(id); setTimeout(() => setDone((c) => (c === id ? '' : c)), 1800) }
      setMsg(ok ? { ok: true, t: `Abierta: ${o.name || 'salida ' + id}` } : { ok: false, t: `No respondió OK (${(d && (d.status || d.error)) || '—'})` })
    } catch (e) { setMsg({ ok: false, t: e.message || 'No se pudo accionar' }) }
    finally { setBusy('') }
  }

  return (
    <div className="evrelays" role="group" aria-label="Relés y puertas">
      <span className="evrelays__hd"><Icon name="route" size={13} /> Puertas</span>
      <div className="evrelays__list">
        {outputs.map((o, i) => {
          const id = String(o.id != null ? o.id : (o.output != null ? o.output : i + 1))
          const label = o.name || `Salida ${id}`
          const isConfirm = confirmId === id
          const isBusy = busy === id
          const isDone = done === id
          return (
            <div key={i} className={`evrelay${isConfirm ? ' is-confirm' : ''}${isBusy ? ' is-busy' : ''}${isDone ? ' is-done' : ''}`}>
              {isConfirm ? (
                <div className="evrelay__confirm" role="group" aria-label={`Confirmar apertura de ${label}`}>
                  <span className="evrelay__q">¿Abrir {label}?</span>
                  <button type="button" className="evrelay__yes" onClick={() => fire(o, id)} aria-label="Confirmar apertura" data-tip="Confirmar — acciona la salida física">
                    <Icon name="check" size={16} />
                  </button>
                  <button type="button" className="evrelay__no" onClick={cancel} aria-label="Cancelar" data-tip="Cancelar">
                    <Icon name="x" size={16} />
                  </button>
                </div>
              ) : (
                <button type="button" className="evrelay__btn" disabled={closed || isBusy}
                  onClick={() => ask(id)} title={`Abrir ${label}`}
                  data-tip="Abrir puerta / accionar relé (pide confirmación)">
                  <span className="evrelay__ic" aria-hidden="true">
                    <Icon name={isDone ? 'check' : 'route'} size={19} />
                  </span>
                  <span className="evrelay__lbl">{isBusy ? 'Accionando…' : isDone ? 'Abierta' : label}</span>
                </button>
              )}
            </div>
          )
        })}
      </div>
      {msg && <span className={`evrelay__msg ${msg.ok ? 'is-ok' : 'is-err'}`}>{msg.t}</span>}
    </div>
  )
}
