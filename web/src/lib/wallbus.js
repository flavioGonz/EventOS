// wallbus — canal same-origin entre la consola del operador y las ventanas del
// Videowall (típicamente en otro monitor del mismo PC). Cuando el operador
// SELECCIONA/abre un evento en la consola, se emite un "focus-site" para que el/los
// muros abiertos carguen TODAS las cámaras del cliente (sitio) que reportó el evento.
//
// No usa el servidor: viaja por BroadcastChannel (mismo origen, entre ventanas/pestañas)
// con respaldo en localStorage (evento 'storage', que también cruza ventanas). Ambos
// mecanismos entregan SOLO a las OTRAS ventanas, no a la que emite — que es justo lo
// que queremos (la consola emite, los muros reciben).

const CH = 'eventos-wall'
const LS_KEY = 'eventos.wall.focus'

let bc = null
function chan() {
  if (bc) return bc
  try { bc = new BroadcastChannel(CH) } catch { bc = null }
  return bc
}

export function postWallFocus(payload) {
  const msg = { ...payload, at: Date.now() }
  try { const c = chan(); if (c) c.postMessage(msg) } catch { /* noop */ }
  // Respaldo: escribir en localStorage dispara 'storage' en las demás ventanas.
  try { localStorage.setItem(LS_KEY, JSON.stringify(msg)) } catch { /* noop */ }
}

export function onWallFocus(cb) {
  const c = chan()
  const onMsg = (e) => { if (e && e.data) cb(e.data) }
  if (c) c.addEventListener('message', onMsg)
  const onStorage = (e) => {
    if (e.key === LS_KEY && e.newValue) { try { cb(JSON.parse(e.newValue)) } catch { /* noop */ } }
  }
  window.addEventListener('storage', onStorage)
  return () => {
    try { if (c) c.removeEventListener('message', onMsg) } catch { /* noop */ }
    window.removeEventListener('storage', onStorage)
  }
}
