import { useEffect, useRef, useState } from 'react'
import { sim } from '../lib/socket.js'
import { Button, Glass, Icon, PriorityDot, StatusDot, ThemeToggle } from '../ui/primitives.jsx'
import { PAUSE_REASONS, pauseReasonLabel, operatorStatusLabel } from '../lib/labels.js'
import OperatorMenu from './OperatorMenu.jsx'

function initials(name = '') {
  return name.trim().split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase() || '·'
}

// Sub-barra de la consola (no es la barra de marca, que vive en el shell).
// Izquierda: estado en vivo (socket + bus redis). Centro: chips de cola.
// Derecha: control de pausa/tiempo del operario + grupo del Simulador.

// --- Formato de duración ------------------------------------------------------
// fmtDuration(ms): >1h → "1h 23m"; <1h → "MM:SS". Para el reloj de sesión usamos
// el formato extendido HH:MM:SS (fmtClock).
function fmtDuration(ms) {
  const s = Math.max(0, Math.floor((ms || 0) / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
}
function fmtClock(ms) {
  const s = Math.max(0, Math.floor((ms || 0) / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
}

const PAUSE_ICON = {
  descanso: 'coffee', almuerzo: 'coffee', capacitacion: 'users', bano: 'clock', otro: 'pause',
}

export default function OperatorBar({ operator, onChangeOperator, viewToggle, status, redis, operators, summary, selfStats, actions, autoPopup, onToggleAutoPopup }) {
  const [running, setRunning] = useState(false)
  const [busy, setBusy] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [now, setNow] = useState(Date.now()) // tick local de 1s para los relojes en vivo
  const menuRef = useRef(null)

  const online = (operators || []).filter((o) => o.online).length

  const socketTone = status === 'connected' ? 'ok' : status === 'connecting' ? 'warn' : 'off'
  const socketLabel =
    status === 'connected' ? 'Conectado' : status === 'connecting' ? 'Conectando…' : 'Sin conexión'
  const redisTone = redis === 'connected' ? 'ok' : redis === 'memory' ? 'warn' : 'off'
  const redisLabel = redis === 'connected' ? 'Redis' : redis === 'memory' ? 'Memoria' : '—'

  const critical = (summary && summary.critical) || 0
  const active = (summary && summary.active) || 0

  // Estado/tiempo propios del operario (CONTRACT-V3 §1). Pueden faltar al arrancar.
  const stats = selfStats || {}
  const opStatus = stats.status || 'available'
  const paused = opStatus === 'paused'
  const handled = stats.handled ?? 0

  // Reloj en vivo: avanza 1s localmente. Reinicia/ajusta cuando llega `operator:self`.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  // Sesión = acumulado disponible + acumulado en pausa + delta del estado actual.
  const sessionStartMs = stats.sessionStart ? Date.parse(stats.sessionStart) : null
  const pauseSinceMs = stats.pauseSince ? Date.parse(stats.pauseSince) : null
  // Tiempo total de sesión: si tenemos sessionStart, contamos desde ahí (incluye
  // disponible + pausa). Si no, sumamos los acumuladores + delta vivo del estado.
  let sessionMs
  if (sessionStartMs) {
    sessionMs = now - sessionStartMs
  } else {
    const liveDelta = paused && pauseSinceMs ? now - pauseSinceMs : 0
    sessionMs = (stats.msAvailable || 0) + (stats.msPaused || 0) + liveDelta
  }
  // Tiempo en la pausa actual.
  const curPauseMs = paused && pauseSinceMs ? now - pauseSinceMs : 0

  // Cerrar el menú de motivos al hacer click fuera o con Escape.
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false) }
    const onKey = (e) => { if (e.key === 'Escape') setMenuOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [menuOpen])

  async function call(fn, after) {
    setBusy(true)
    try {
      await fn()
      if (after) after()
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('Simulador:', err.message)
    } finally {
      setBusy(false)
    }
  }

  const doPause = (reason) => {
    setMenuOpen(false)
    actions?.pause?.(reason)
  }
  const doResume = () => actions?.resume?.()

  // --- Auto-ocultar la barra + pantalla completa ---
  const [tucked, setTucked] = useState(false)
  const [fs, setFs] = useState(false)
  const hideTimer = useRef(null)
  const menuOpenRef = useRef(false); menuOpenRef.current = menuOpen
  const armHide = () => { clearTimeout(hideTimer.current); hideTimer.current = setTimeout(() => { if (!menuOpenRef.current) setTucked(true) }, 6000) }
  useEffect(() => { armHide(); return () => clearTimeout(hideTimer.current) }, [])
  useEffect(() => {
    const on = () => setFs(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', on); on()
    return () => document.removeEventListener('fullscreenchange', on)
  }, [])
  const toggleFs = () => { try { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen() } catch { /* noop */ } }

  return (
    <>
    <div className="opbar-reveal" onMouseEnter={() => { setTucked(false); armHide() }} aria-hidden="true" />
    <Glass as="header" className={`opbar ${paused ? 'opbar--paused' : ''} ${tucked ? 'is-tucked' : ''}`}
      onMouseEnter={() => { setTucked(false); clearTimeout(hideTimer.current) }}
      onMouseLeave={armHide}>
      <nav className="opbar__nav">
        <a href="/" className={`opbar__navlink${(typeof window !== 'undefined' && window.location.pathname === '/') ? ' is-active' : ''}`}><Icon name="console" size={15} /><span>Consola</span></a>
        <a href="/center" className={`opbar__navlink${(typeof window !== 'undefined' && window.location.pathname.startsWith('/center')) ? ' is-active' : ''}`}><Icon name="bell" size={15} /><span>Centro</span></a>
      </nav>
      {viewToggle && <div className="opbar__view">{viewToggle}</div>}
      <div className="opbar__chips">
        <span className={`qchip ${critical > 0 ? 'qchip--crit' : ''}`} title="Eventos críticos activos">
          {critical > 0 && <PriorityDot p={1} size={8} />}
          <strong className="tnum">{critical}</strong>
          <span>Críticos</span>
        </span>
        <span className="qchip" title="Eventos activos">
          <strong className="tnum">{active}</strong>
          <span>Activos</span>
        </span>
        <span className="qchip" title="Operarios en línea">
          <StatusDot tone={online > 0 ? 'ok' : 'off'} />
          <strong className="tnum">{online}</strong>
          <span>Operarios</span>
        </span>
      </div>

      {onToggleAutoPopup && (
        <button type="button" role="switch" aria-checked={!!autoPopup} className={`opbar__sw ${autoPopup ? 'is-on' : ''}`} onClick={onToggleAutoPopup}
          title={autoPopup ? 'Pop-up automático de alarmas: activado' : 'Pop-up automático de alarmas: desactivado'}>
          <Icon name="bell" size={14} />
          <span className="opbar__sw-label">Pop-up</span>
          <span className="opbar__sw-track"><span className="opbar__sw-knob" /></span>
        </button>
      )}
      <div className="opbar__spacer" />

      {/* --- Presencia / pausa / tiempo del operario (CONTRACT-V3 §1) --- */}
      <div className="opself" ref={menuRef}>
        <div className="opself__state" title={`Estado: ${operatorStatusLabel(opStatus)}`}>
          <StatusDot tone={paused ? 'warn' : 'ok'} label={operatorStatusLabel(opStatus)} />
          <span className="opself__status-label">
            {paused
              ? <>En pausa{stats.pauseReason ? ` · ${pauseReasonLabel(stats.pauseReason)}` : ''}</>
              : 'Disponible'}
          </span>
        </div>

        <div className="opself__times" aria-live="polite">
          <span className="opself__time" title="Tiempo total de sesión">
            <Icon name="clock" size={13} />
            <span className="opself__time-label">Sesión</span>
            <strong className="tnum">{fmtClock(sessionMs)}</strong>
          </span>
          {paused && (
            <span className="opself__time opself__time--warn" title="Tiempo en la pausa actual">
              <Icon name="pause" size={13} />
              <span className="opself__time-label">En pausa</span>
              <strong className="tnum">{fmtDuration(curPauseMs)}</strong>
            </span>
          )}
          <span className="opself__time" title="Eventos atendidos en la sesión">
            <span className="opself__time-label">Atendidos</span>
            <strong className="tnum">{handled}</strong>
          </span>
        </div>

        {paused ? (
          <Button variant="primary" size="sm" icon="play" disabled={busy} onClick={doResume}>
            Reanudar
          </Button>
        ) : (
          <div className="opself__pause">
            <Button
              variant="secondary"
              size="sm"
              icon="pause"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((v) => !v)}
            >
              Pausa
            </Button>
            {menuOpen && (
              <Glass strong className="opself__menu anim-pop" role="menu">
                <p className="opself__menu-title">Motivo de la pausa</p>
                {PAUSE_REASONS.map((r) => (
                  <button key={r} role="menuitem" className="opself__menu-item" onClick={() => doPause(r)}>
                    <Icon name={PAUSE_ICON[r] || 'pause'} size={15} />
                    <span>{pauseReasonLabel(r)}</span>
                  </button>
                ))}
              </Glass>
            )}
          </div>
        )}
      </div>

      <span className="opbar__div" aria-hidden="true" />

      <div className="opbar__sim">
        <span className="opbar__sim-label">
          <Icon name="bolt" size={14} /> Simulador
        </span>
        <Button variant="secondary" size="sm" disabled={busy} onClick={() => call(() => sim.burst(5))}>
          Ráfaga ×5
        </Button>
        {running ? (
          <Button
            variant="danger"
            size="sm"
            icon="x"
            disabled={busy}
            onClick={() => call(() => sim.stop(), () => setRunning(false))}
          >
            Detener
          </Button>
        ) : (
          <Button
            variant="primary"
            size="sm"
            icon="bolt"
            disabled={busy}
            onClick={() => call(() => sim.start(4000), () => setRunning(true))}
          >
            Iniciar
          </Button>
        )}
      </div>

      <span className="opbar__div" aria-hidden="true" />

      {/* Identidad del operario + accesos por ROL + tema. Escalonado:
          agente = solo consola · supervisor = +Supervisor +Videowall ·
          admin = +Administración. */}
      <div className="opbar__ident">
        {(() => {
          const role = (operator && operator.role) || 'agente'
          const canSup = role === 'supervisor' || role === 'admin'
          const isAdmin = role === 'admin'
          return <>
            {canSup && (
              <a className="op-wall" href="/supervisor" title="Panel de supervisor">
                <Icon name="gauge" size={16} />
              </a>
            )}
            {canSup && (
              <a className="op-wall" href="/wall" title="Abrir Videowall multipantalla">
                <Icon name="grid" size={16} />
              </a>
            )}
            {isAdmin && (
              <a className="op-wall" href="/admin" title="Administración">
                <Icon name="shield" size={16} />
              </a>
            )}
          </>
        })()}
        <button type="button" className="op-wall" onClick={toggleFs} title={fs ? 'Salir de pantalla completa' : 'Pantalla completa'} aria-label="Pantalla completa">
          <Icon name="expand" size={16} />
        </button>
        <button type="button" className="op-wall" onClick={() => setTucked(true)} title="Ocultar barra (reaparece al pasar el mouse arriba)" aria-label="Ocultar barra">
          <Icon name="chevron" size={16} />
        </button>
        <ThemeToggle />
        {operator && <OperatorMenu operator={operator} onChangeOperator={onChangeOperator} />}
      </div>
    </Glass>
    </>
  )
}
