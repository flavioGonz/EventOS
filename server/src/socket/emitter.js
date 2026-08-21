// emitter.js — puente para emitir mensajes ad-hoc al namespace /console desde
// fuera del socket (p.ej. la ingesta de accesos). Proceso único: `nsp.emit`
// alcanza a todos los operadores conectados. Si en el futuro se escala a varios
// procesos, habría que rutear esto por el bus (Redis pub/sub) como los eventos.
let nsp = null;

export function setConsoleNsp(n) { nsp = n; }

// Emite una lectura de acceso efímera. No toca la cola de eventos ni el video.
export function emitAccessRead(payload) {
  if (!nsp || !payload) return false;
  try { nsp.emit("access:read", payload); return true; } catch { return false; }
}

export default { setConsoleNsp, emitAccessRead };
