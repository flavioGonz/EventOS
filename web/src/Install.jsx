import { useEffect, useState } from 'react'
import { Icon } from './ui/primitives.jsx'

function useInstallPrompt() {
  const [deferred, setDeferred] = useState(null)
  const [installed, setInstalled] = useState(false)
  useEffect(() => {
    const onBip = (e) => { e.preventDefault(); setDeferred(e) }
    const onInst = () => { setInstalled(true); setDeferred(null) }
    window.addEventListener('beforeinstallprompt', onBip)
    window.addEventListener('appinstalled', onInst)
    return () => { window.removeEventListener('beforeinstallprompt', onBip); window.removeEventListener('appinstalled', onInst) }
  }, [])
  const promptInstall = async () => { if (!deferred) return false; deferred.prompt(); const r = await deferred.userChoice.catch(() => null); setDeferred(null); return !!r && r.outcome === 'accepted' }
  return { canInstall: !!deferred, installed, promptInstall }
}

const CARDS = [
  { role: 'operador', name: 'EventOS · Operador', desc: 'Centro de alarmas, verificación y despacho. Para el puesto de operador.', icon: 'bell', accent: '#5b9cff' },
  { role: 'supervisor', name: 'EventOS · Supervisor', desc: 'Panel de supervisión, métricas y videowall. Para el supervisor.', icon: 'gauge', accent: '#a882ff' },
]
const openUrl = (r) => (r === 'supervisor' ? '/supervisor?app=supervisor' : '/center?app=operador')
const installUrl = (r) => `/instalar?app=${r}`

export default function Install() {
  const current = new URLSearchParams(window.location.search).get('app') === 'supervisor' ? 'supervisor' : 'operador'
  const { canInstall, installed, promptInstall } = useInstallPrompt()
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent)
  const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone

  return (
    <div className="pwainstall">
      <header className="pwainstall__head">
        <span className="pwainstall__logo"><Icon name="bolt" size={22} /></span>
        <div>
          <h1>Instalar EventOS</h1>
          <p>Elegí la app según tu rol. Se instala como aplicación de escritorio, con su propio ícono y ventana.</p>
        </div>
      </header>
      {installed && <div className="pwainstall__ok"><Icon name="check" size={16} /> App instalada — buscala en tu escritorio / menú de inicio.</div>}
      {standalone && <div className="pwainstall__ok"><Icon name="check" size={16} /> Ya estás en la app instalada.</div>}
      <div className="pwainstall__grid">
        {CARDS.map((cd) => {
          const isCurrent = cd.role === current
          return (
            <div key={cd.role} className={`pwacard${isCurrent ? ' is-current' : ''}`} style={{ '--acc': cd.accent }}>
              <span className="pwacard__icon"><Icon name={cd.icon} size={26} /></span>
              <h2>{cd.name}</h2>
              <p>{cd.desc}</p>
              <div className="pwacard__actions">
                {isCurrent
                  ? (canInstall
                    ? <button type="button" className="pwacard__btn" onClick={promptInstall}><Icon name="plus" size={15} /> Instalar esta app</button>
                    : <a className="pwacard__btn" href={openUrl(cd.role)}>Abrir</a>)
                  : <a className="pwacard__btn pwacard__btn--ghost" href={installUrl(cd.role)}>Instalar {cd.role}</a>}
                <a className="pwacard__open" href={openUrl(cd.role)}>o abrir en el navegador →</a>
              </div>
            </div>
          )
        })}
      </div>
      {isIOS && <p className="pwainstall__ios"><Icon name="phone" size={14} /> En iPhone/iPad: tocá <b>Compartir</b> → <b>Agregar a inicio</b>.</p>}
      <p className="pwainstall__hint">El botón “Instalar esta app” aparece cuando el navegador lo permite (Chrome/Edge de escritorio). Si no aparece, usá el menú del navegador → <b>Instalar EventOS</b>. Cada rol instala su propia app con su ícono.</p>
    </div>
  )
}
