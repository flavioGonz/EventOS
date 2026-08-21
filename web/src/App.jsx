import { useCallback, useEffect, useState } from 'react'
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import OperatorBar from './components/OperatorBar.jsx'
import OthersWorking from './components/OthersWorking.jsx'
import LiveBoard from './components/LiveBoard.jsx'
import OperativeMap from './components/OperativeMap.jsx'
import EventPopup from './components/EventPopup.jsx'
import OperatorIdentity from './components/OperatorIdentity.jsx'
import Login from './components/Login.jsx'
import AdminApp from './admin/AdminApp.jsx'
import Videowall from './components/Videowall.jsx'
import AlarmCenter from './components/AlarmCenter.jsx'
import Install from './Install.jsx'
import SupervisorStandalone from './SupervisorStandalone.jsx'
import { loadOperator, saveOperator, useConsole } from './lib/socket.js'
import { Glass, Icon, Segmented, ThemeToggle } from './ui/primitives.jsx'
import './ui/shell.css'

function initials(name = '') {
  return name.trim().split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase() || '·'
}

function TopBar({ operator, status, onChangeOperator }) {
  return (
    <Glass as="header" className="topbar">
      <div className="topbar__brand">
        <span className="topbar__logo"><Icon name="brand" size={15} /></span>
        <b>EventOS</b><span>· ARC</span>
      </div>
      <nav className="topnav">
        <NavLink to="/" end className={({ isActive }) => (isActive ? 'is-active' : '')}>
          <Icon name="console" size={16} /> Consola
        </NavLink>
        <NavLink to="/admin" className={({ isActive }) => (isActive ? 'is-active' : '')}>
          <Icon name="shield" size={16} /> Administración
        </NavLink>
      </nav>
      <div className="topbar__spacer" />
      <div className="topbar__right">
        <ThemeToggle />
        {operator && (
          <button type="button" className="op-chip" onClick={onChangeOperator}
                  title="Cambiar operario" aria-label={`Operario ${operator.name}. Pulsa para cambiar`}>
            <span className="op-chip__av">{initials(operator.name)}</span>
            <span className="op-chip__name">{operator.name}</span>
          </button>
        )}
      </div>
    </Glass>
  )
}

const VIEW_OPTS = [
  { value: 'map', label: 'Mapa' },
  { value: 'board', label: 'Tablero' },
]

function ConsoleView({ operator, onConfirmIdentity, onChangeOperator, console: c, autoPopup, onToggleAutoPopup }) {
  const { status, redis, events, operators, summary, selfStats, alertEvent, clearAlert, notice, clearNotice, actions } = c
  const [openId, setOpenId] = useState(null)

  useEffect(() => {
    if (autoPopup && alertEvent && !openId) setOpenId(alertEvent.id)
  }, [alertEvent, openId, autoPopup])

  const openEvent = openId ? events.find((e) => e.id === openId) || null : null
  const handleOpen = useCallback((event) => setOpenId(event.id), [])
  const handleClose = useCallback(() => { setOpenId(null); clearAlert() }, [clearAlert])

  if (!operator) return <OperatorIdentity onConfirm={onConfirmIdentity} />

  // El TABLERO es el panel principal de trabajo (el mapa se retiró por ahora).
  return (
    <div className="console console--work">
      <OperatorBar operator={operator} onChangeOperator={onChangeOperator}
                   status={status} redis={redis}
                   operators={operators} summary={summary}
                   selfStats={selfStats} actions={actions}
                   autoPopup={autoPopup} onToggleAutoPopup={onToggleAutoPopup} />
      {notice && (
        <div className={`console-notice console-notice--${notice.tone || 'warn'}`} role="status" onClick={clearNotice}>
          <Icon name="alert" size={16} />
          <span>{notice.text}</span>
        </div>
      )}
      <main className="console__work">
        <LiveBoard events={events} operator={operator} onOpen={handleOpen} />
      </main>

      <OthersWorking events={events} operators={operators} me={operator} />

      {openEvent && (
        <EventPopup event={openEvent} operator={operator} actions={actions} onClose={handleClose} />
      )}
    </div>
  )
}

export default function App() {
  const [operator, setOperator] = useState(() => loadOperator())
  const console_ = useConsole(operator)   // socket vive a nivel app (persiste entre pestañas)
  const [autoPopup, setAutoPopup] = useState(() => { try { return localStorage.getItem('eventos.autopopup') !== '0' } catch { return true } })
  const toggleAutoPopup = useCallback(() => setAutoPopup((v) => { const n = !v; try { localStorage.setItem('eventos.autopopup', n ? '1' : '0') } catch { /* ignore */ } return n }), [])
  const location = useLocation()

  const confirmIdentity = useCallback((op) => { saveOperator(op); setOperator(op) }, [])
  const changeOperator = useCallback(() => {
    fetch('/api/auth/logout', { method: 'POST' }).catch(() => {})
    saveOperator(null); setOperator(null)
  }, [])

  // Al cargar: valida que la cookie de sesión siga viva. Si el localStorage tiene
  // un operario pero el server ya no reconoce la sesión (expiró / restart), vuelve
  // al login en vez de mostrar una consola muerta (socket y video darían 401).
  useEffect(() => {
    if (!operator) return
    let alive = true
    fetch('/api/auth/me')
      .then((r) => { if (alive && r.status === 401) { saveOperator(null); setOperator(null) } })
      .catch(() => {})
    return () => { alive = false }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // primer segmento como clave de transición: anima al cambiar Consola⟷Admin
  const routeKey = '/' + (location.pathname.split('/')[1] || '')
  // La barra de marca (EventOS · ARC) es solo del administrador; la consola de
  // operadores no la muestra (tiene su propia sub-barra).
  const isAdmin = location.pathname.startsWith('/admin')
  // Acceso escalonado por rol: supervisor y admin pueden ver el panel de
  // supervisor y el videowall; el agente solo la consola.
  const role = (operator && operator.role) || 'agente'
  const canSupervise = role === 'supervisor' || role === 'admin'
  const isAdminUser = role === 'admin'

  // Toda la consola vive detrás del login (instancia pública). Sin sesión →
  // pantalla de ingreso, cualquiera sea la ruta (salvo el instalador inicial).
  if (!operator && location.pathname !== '/instalar') {
    return (
      <div className="shell">
        <div className="route"><div className="route__page anim-rise">
          <Login onConfirm={confirmIdentity} />
        </div></div>
      </div>
    )
  }

  return (
    <div className="shell">
      {/* La barra del admin ahora vive dentro de AdminApp (AdminTopNav), unificada
          con el menú; la consola tiene su propia sub-barra. Sin barra global aquí. */}
      <div className="route">
        <div className="route__page anim-rise" key={routeKey}>
          <Routes location={location}>
            <Route path="/instalar" element={<Install />} />
            {/* Modo Consola (LiveBoard) retirado por ahora: el operador tiene una
                sola vista = Centro. ConsoleView queda en el código, sin usar. */}
            <Route path="/" element={<Navigate to="/center" replace />} />
            <Route path="/console" element={
              <ConsoleView operator={operator} onConfirmIdentity={confirmIdentity}
                           onChangeOperator={changeOperator} console={console_}
                           autoPopup={autoPopup} onToggleAutoPopup={toggleAutoPopup} />
            } />
            <Route path="/center" element={
              <AlarmCenter operator={operator} onConfirmIdentity={confirmIdentity}
                           onChangeOperator={changeOperator} console={console_}
                           autoPopup={autoPopup} onToggleAutoPopup={toggleAutoPopup} />
            } />
            {/* El panel de administración es sólo para rol admin. */}
            <Route path="/admin/*" element={isAdminUser ? <AdminApp /> : <Navigate to="/" replace />} />
            <Route path="/wall" element={canSupervise ? <Videowall /> : <Navigate to="/" replace />} />
            <Route path="/supervisor" element={canSupervise ? <SupervisorStandalone /> : <Navigate to="/" replace />} />
          </Routes>
        </div>
      </div>
    </div>
  )
}
