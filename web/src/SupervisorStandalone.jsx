// Página de Supervisor accesible a rol supervisor (sin token de admin). Reutiliza
// el panel Supervisor del admin dentro de un shell mínimo + barra con accesos.
import { NavLink } from 'react-router-dom'
import Supervisor from './admin/Supervisor.jsx'
import { Glass, Icon, ThemeToggle } from './ui/primitives.jsx'
import './admin/admin.css'

export default function SupervisorStandalone() {
  return (
    <div className="admin admin--top anim-pop">
      <Glass className="admin-topbar">
        <span className="admin-topbar__brand">
          <span className="admin-topbar__logo"><Icon name="bolt" size={15} /></span>
          <b>EventOS</b><span className="admin-topbar__sub">· Supervisión</span>
        </span>
        <nav className="admin-topnav">
          <NavLink to="/" end className="admin-navgrp__btn admin-navgrp__solo">
            <Icon name="console" size={16} /><span>Consola</span>
          </NavLink>
          <a className="admin-navgrp__btn admin-navgrp__solo" href="/wall">
            <Icon name="grid" size={16} /><span>Videowall</span>
          </a>
        </nav>
        <ThemeToggle />
      </Glass>
      <main className="admin-main"><Supervisor /></main>
    </div>
  )
}
