// Panel de administración EventOS. CONTRACT-V2 §2/§4.
// Shell de vidrio (sidebar + contenido), gate por X-Admin-Token, rutas anidadas.
import { useCallback, useEffect, useRef, useState } from 'react'
import { NavLink, Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom'
import { Glass, Button, IconButton, Icon, Field, TextInput, Spinner, ThemeToggle } from '../ui/primitives.jsx'
import { ping, setAdminToken, getAdminToken, clearAdminToken, ApiError } from '../lib/adminApi.js'
import { ToastProvider } from './_shared.jsx'
import Devices from './Devices.jsx'
import DeviceEdit from './DeviceEdit.jsx'
import DeviceDiscover from './DeviceDiscover.jsx'
import DeviceWizard from './DeviceWizard.jsx'
import Sites from './Sites.jsx'
import SiteEdit from './SiteEdit.jsx'
import Operators from './Operators.jsx'
import OperatorEdit from './OperatorEdit.jsx'
import Groups from './Groups.jsx'
import GroupEdit from './GroupEdit.jsx'
import Rules from './Rules.jsx'
import RuleEdit from './RuleEdit.jsx'
import Procedures from './Procedures.jsx'
import ProcedureEdit from './ProcedureEdit.jsx'
import Dispatch from './Dispatch.jsx'
import Reception from './Reception.jsx'
import Supervisor from './Supervisor.jsx'
import Health from './Health.jsx'
import EvidenceSearch from './EvidenceSearch.jsx'
import VisualTracking from './VisualTracking.jsx'
import Flujos from './Flujos.jsx'
import Settings from './Settings.jsx'
import './admin.css'

// Menú agrupado por criterio: ACTIVOS (lo físico que genera eventos), OPERADORES
// (las personas), AUTOMATIZACIÓN (la lógica de respuesta) y DESPACHO (operación en
// vivo). Configuración va suelta a la derecha.
const NAV_GROUPS = [
  { key: 'activos', label: 'Activos', icon: 'device', items: [
    { to: 'devices', icon: 'device', label: 'Dispositivos' },
    { to: 'sites',   icon: 'site',   label: 'Sitios' },
    { to: 'tracking', icon: 'map',   label: 'Plano de cámaras' },
    { to: 'health',  icon: 'gauge',  label: 'Salud NVR' },
  ] },
  { key: 'personas', label: 'Operadores', icon: 'users', items: [
    { to: 'operators', icon: 'users',      label: 'Operarios' },
    { to: 'groups',    icon: 'shieldcheck', label: 'Grupos' },
  ] },
  { key: 'auto', label: 'Automatización', icon: 'rules', items: [
    { to: 'rules',      icon: 'rules',     label: 'Reglas' },
    { to: 'procedures', icon: 'procedure', label: 'Procedimientos' },
  ] },
  { key: 'despacho', label: 'Despacho', icon: 'balance', items: [
    { to: 'reception', icon: 'reception', label: 'Recepción' },
    { to: 'dispatch',  icon: 'balance',   label: 'Balanceo' },
    { to: 'flujos',    icon: 'layers',    label: 'Flujos' },
  ] },
]
const NAV_SETTINGS = { to: 'settings', icon: 'sliders', label: 'Configuración' }

const COLLAPSE_KEY = 'eventos.adminCollapsed'

/* ---------- Login gate ---------- */
function TokenGate({ onAuth }) {
  const [token, setTok] = useState(getAdminToken())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true); setError('')
    setAdminToken(token.trim())
    try {
      await ping()
      onAuth()
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setError('Token incorrecto. Verifícalo e inténtalo de nuevo.')
      else setError(err?.message || 'No se pudo validar el token')
      setBusy(false)
    }
  }

  return (
    <div className="admin-gate">
      <Glass strong className="admin-gate__card anim-pop" as="form" onSubmit={submit}>
        <div className="admin-gate__icon"><Icon name="shield" size={24} /></div>
        <h2>Administración</h2>
        <p>Introduce el token de administración para gestionar la configuración de EventOS.</p>
        <Field label="Token de administración" error={error}>
          <TextInput
            type="password" autoFocus value={token} placeholder="X-Admin-Token"
            onChange={(e) => setTok(e.target.value)}
          />
        </Field>
        <div style={{ marginTop: 18, display: 'flex', justifyContent: 'flex-end' }}>
          <Button type="submit" variant="primary" icon={busy ? undefined : 'check'} disabled={busy}>
            {busy ? <Spinner size={15} /> : 'Entrar'}
          </Button>
        </div>
      </Glass>
    </div>
  )
}

/* ---------- Grupo de menú con desplegable ---------- */
function NavGroup({ group }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  const location = useLocation()
  const active = group.items.some((it) => location.pathname.startsWith(`/admin/${it.to}`))

  useEffect(() => {
    if (!open) return
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    const onEsc = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDoc); document.addEventListener('keydown', onEsc)
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onEsc) }
  }, [open])
  useEffect(() => { setOpen(false) }, [location.pathname]) // cierra al navegar

  return (
    <div className={`admin-navgrp${open ? ' is-open' : ''}`} ref={ref}>
      <button type="button" className={`admin-navgrp__btn${active ? ' is-active' : ''}`}
              onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <Icon name={group.icon} size={16} />
        <span>{group.label}</span>
        <Icon name="chevron" size={13} className="admin-navgrp__chev" />
      </button>
      {open && (
        <div className="admin-navgrp__menu anim-pop">
          {group.items.map((it) => (
            <NavLink key={it.to} to={it.to}
                     className={({ isActive }) => `admin-navgrp__item${isActive ? ' is-active' : ''}`}>
              <Icon name={it.icon} size={15} /><span>{it.label}</span>
            </NavLink>
          ))}
        </div>
      )}
    </div>
  )
}

/* ---------- Barra superior de navegación (sin sidebar) ---------- */
function AdminTopNav({ onLogout }) {
  return (
    <Glass as="header" className="admin-topbar">
      {/* La marca vuelve a la Consola (el cambio Consola/Admin/Supervisor vive en
          la barra del operador, por rol; el menú de admin solo tiene secciones). */}
      <NavLink to="/" end className="admin-topbar__brand" title="Volver a la consola">
        <span className="admin-topbar__logo"><Icon name="bolt" size={15} /></span>
        <b>EventOS</b><span className="admin-topbar__sub">· ARC</span>
      </NavLink>
      <nav className="admin-topnav">
        {NAV_GROUPS.map((g) => <NavGroup key={g.key} group={g} />)}
        <NavLink to={NAV_SETTINGS.to} title={NAV_SETTINGS.label}
                 className={({ isActive }) => `admin-navgrp__btn admin-navgrp__solo${isActive ? ' is-active' : ''}`}>
          <Icon name={NAV_SETTINGS.icon} size={16} /><span>{NAV_SETTINGS.label}</span>
        </NavLink>
        <NavLink to="search" title="Búsqueda IA de evidencias"
                 className={({ isActive }) => `admin-navgrp__btn admin-navgrp__solo${isActive ? ' is-active' : ''}`}>
          <Icon name="search" size={16} /><span>Búsqueda IA</span>
        </NavLink>
        <a className="admin-navgrp__btn admin-navgrp__solo" href="/wall" title="Videowall multipantalla">
          <Icon name="grid" size={16} /><span>Videowall</span>
        </a>
      </nav>
      <ThemeToggle />
      <button type="button" className="admin-topnav__logout" onClick={onLogout} title="Cerrar sesión">
        <Icon name="logout" size={16} />
        <span>Salir</span>
      </button>
    </Glass>
  )
}

/* ---------- Layout del admin (barra superior + contenido); el login va aparte ---------- */
function AdminShellLayout({ onLogout }) {
  return (
    <div className="admin admin--top anim-pop">
      <AdminTopNav onLogout={onLogout} />
      <main className="admin-main"><Outlet /></main>
    </div>
  )
}

export default function AdminApp() {
  const [authed, setAuthed] = useState(false)
  const [checking, setChecking] = useState(true)
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(COLLAPSE_KEY) === '1' } catch { return false }
  })

  // Ping inicial: si no hay token configurado en el server, devuelve ok directo.
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        await ping()
        if (alive) setAuthed(true)
      } catch (err) {
        // 401 → mostrar gate. Otros errores también caen al gate (mostrará el msg al enviar).
        if (alive) setAuthed(false)
      } finally {
        if (alive) setChecking(false)
      }
    })()
    return () => { alive = false }
  }, [])

  const logout = useCallback(() => {
    clearAdminToken()
    setAuthed(false)
  }, [])

  const toggleCollapse = useCallback(() => {
    setCollapsed((c) => {
      const next = !c
      try { localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0') } catch { /* ignore */ }
      return next
    })
  }, [])

  if (checking) {
    return <div className="admin-center"><Spinner size={24} /><span>Comprobando acceso…</span></div>
  }

  return (
    <ToastProvider>
      <Routes>
        {/* Login en su propia ruta, separado del panel (sin sidebar). */}
        <Route path="login" element={authed
          ? <Navigate to="/admin" replace />
          : <TokenGate onAuth={() => setAuthed(true)} />} />

        {/* Panel protegido: si no hay sesión, redirige al login. */}
        <Route element={authed
          ? <AdminShellLayout onLogout={logout} />
          : <Navigate to="/admin/login" replace />}>
          <Route index element={<Navigate to="devices" replace />} />
          <Route path="supervisor" element={<Supervisor />} />
          <Route path="search" element={<EvidenceSearch />} />
          <Route path="tracking" element={<VisualTracking />} />
          <Route path="health" element={<Health />} />
          <Route path="devices" element={<Devices />} />
          <Route path="devices/discover" element={<DeviceDiscover />} />
          <Route path="devices/wizard" element={<DeviceWizard />} />
          <Route path="devices/new" element={<DeviceEdit />} />
          <Route path="devices/:id" element={<DeviceEdit />} />
          <Route path="sites" element={<Sites />} />
          <Route path="sites/new" element={<SiteEdit />} />
          <Route path="sites/:id" element={<SiteEdit />} />
          <Route path="operators" element={<Operators />} />
          <Route path="operators/new" element={<OperatorEdit />} />
          <Route path="operators/:id" element={<OperatorEdit />} />
          <Route path="groups" element={<Groups />} />
          <Route path="groups/new" element={<GroupEdit />} />
          <Route path="groups/:id" element={<GroupEdit />} />
          <Route path="rules" element={<Rules />} />
          <Route path="rules/new" element={<RuleEdit />} />
          <Route path="rules/:id" element={<RuleEdit />} />
          <Route path="procedures" element={<Procedures />} />
          <Route path="procedures/new" element={<ProcedureEdit />} />
          <Route path="procedures/:id" element={<ProcedureEdit />} />
          <Route path="dispatch" element={<Dispatch />} />
          <Route path="reception" element={<Reception />} />
          <Route path="flujos" element={<Flujos />} />
          <Route path="settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="devices" replace />} />
        </Route>
      </Routes>
    </ToastProvider>
  )
}
