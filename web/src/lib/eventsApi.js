// eventsApi — fetch a la API same-origin llevando SIEMPRE la cookie de sesión
// (operador) y, si existe, el header X-Admin-Token (panel admin). El guard del
// backend (`PROTECTED` en http/api.js) acepta cualquiera de los dos, así que el
// mismo llamado funciona en la consola del operador y en el panel admin.
import { getAdminToken } from './adminApi.js'

export function apiFetch(url, opts = {}) {
  const t = getAdminToken()
  const headers = { Accept: 'application/json', ...(opts.headers || {}) }
  if (t) headers['X-Admin-Token'] = t
  return fetch(url, { credentials: 'same-origin', ...opts, headers })
}
