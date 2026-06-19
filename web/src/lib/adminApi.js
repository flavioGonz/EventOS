// Capa de datos del panel de administración. CONTRACT-V2 §2.
// Envuelve fetch sobre /api/admin/*, inyecta X-Admin-Token desde localStorage,
// lanza en respuestas no-2xx. Más un hook simple useAdminData(collection).
import { useCallback, useEffect, useRef, useState } from 'react'

const LS_TOKEN = 'eventos.adminToken'
const BASE = '/api/admin'

export function getAdminToken() {
  try { return localStorage.getItem(LS_TOKEN) || '' } catch { return '' }
}
export function setAdminToken(token) {
  try {
    if (token) localStorage.setItem(LS_TOKEN, token)
    else localStorage.removeItem(LS_TOKEN)
  } catch { /* ignore */ }
}
export function clearAdminToken() { setAdminToken('') }

// Error tipado para distinguir 401 (token inválido) del resto.
export class ApiError extends Error {
  constructor(message, status, body) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.body = body
  }
}

async function request(method, path, body) {
  const headers = { Accept: 'application/json' }
  const token = getAdminToken()
  if (token) headers['X-Admin-Token'] = token
  const opts = { method, headers }
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    opts.body = JSON.stringify(body)
  }

  let res
  try {
    res = await fetch(`${BASE}${path}`, opts)
  } catch (e) {
    throw new ApiError('No se pudo conectar con el servidor', 0, null)
  }

  let data = null
  const text = await res.text()
  if (text) { try { data = JSON.parse(text) } catch { data = text } }

  if (!res.ok) {
    const msg = (data && (data.error || data.message)) || `Error ${res.status}`
    throw new ApiError(msg, res.status, data)
  }
  return data
}

// --- Verbos crudos ----------------------------------------------------------
export const api = {
  get:    (path)       => request('GET', path),
  post:   (path, body) => request('POST', path, body),
  put:    (path, body) => request('PUT', path, body),
  del:    (path)       => request('DELETE', path),
}

// --- Endpoints de alto nivel ------------------------------------------------
// Valida X-Admin-Token. Devuelve { ok, requiresToken? } o lanza en 401.
export function ping() { return api.post('/ping', {}) }

export const getConfig     = () => api.get('/config')
export const getReception  = () => api.get('/reception')
export const getDispatch   = () => api.get('/dispatch')
export const putDispatch   = (policy) => api.put('/dispatch', policy)
export const getVideoCfg   = () => api.get('/video')
export const putVideoCfg   = (patch) => api.put('/video', patch)
export const getNvrHealth  = () => api.get('/nvr-health')
export const testDeviceAlert = (id) => api.post(`/devices/${id}/test-alert`, {})

// CRUD genérico por colección (devices, sites, operators, rules, procedures).
export function collectionApi(name) {
  const root = `/${name}`
  return {
    list:   () => api.get(root),
    get:    (id)        => api.get(`${root}/${encodeURIComponent(id)}`),
    create: (item)     => api.post(root, item),
    update: (id, item) => api.put(`${root}/${encodeURIComponent(id)}`, item),
    remove: (id)       => api.del(`${root}/${encodeURIComponent(id)}`),
  }
}

// Las colecciones pueden venir como array directo o envueltas { devices:[...] }.
export function unwrap(data, name) {
  if (Array.isArray(data)) return data
  if (data && Array.isArray(data[name])) return data[name]
  if (data && Array.isArray(data.items)) return data.items
  return []
}

// --- Hook de datos para una colección CRUD ----------------------------------
// Devuelve { items, loading, error, reload, create, update, remove, busy }.
export function useAdminData(name) {
  const c = useRef(collectionApi(name)).current
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  const reload = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const data = await c.list()
      setItems(unwrap(data, name))
    } catch (e) {
      setError(e)
    } finally {
      setLoading(false)
    }
  }, [c, name])

  useEffect(() => { reload() }, [reload])

  const create = useCallback(async (item) => {
    setBusy(true)
    try { const r = await c.create(item); await reload(); return r }
    finally { setBusy(false) }
  }, [c, reload])

  const update = useCallback(async (id, item) => {
    setBusy(true)
    try { const r = await c.update(id, item); await reload(); return r }
    finally { setBusy(false) }
  }, [c, reload])

  const remove = useCallback(async (id) => {
    setBusy(true)
    try { const r = await c.remove(id); await reload(); return r }
    finally { setBusy(false) }
  }, [c, reload])

  return { items, loading, error, busy, reload, create, update, remove }
}

// Catálogo de tipos de evento (espejo de server/src/events/catalog.js, §2).
export const EVENT_CATALOG = {
  line_crossing:   { category: 'video',     title: 'Cruce de línea' },
  intrusion:       { category: 'intrusion', title: 'Intrusión detectada' },
  region_entrance: { category: 'intrusion', title: 'Entrada a zona' },
  region_exit:     { category: 'intrusion', title: 'Salida de zona' },
  motion:        { category: 'video',     title: 'Movimiento' },
  face:          { category: 'video',     title: 'Detección de rostro' },
  lpr:           { category: 'video',     title: 'Matrícula (LPR)' },
  tamper:        { category: 'system',    title: 'Sabotaje de cámara' },
  video_loss:    { category: 'system',    title: 'Pérdida de video' },
  doorbell:      { category: 'access',    title: 'Llamada de portero' },
  door_forced:   { category: 'access',    title: 'Puerta forzada' },
  door_held:     { category: 'access',    title: 'Puerta mantenida abierta' },
  access_denied: { category: 'access',    title: 'Acceso denegado' },
  alarm:         { category: 'intrusion', title: 'Alarma de pánico/intrusión' },
  tamper_alarm:  { category: 'intrusion', title: 'Tamper de central de alarma' },
  system:        { category: 'system',    title: 'Evento de sistema' },
}
export const EVENT_TYPES = Object.keys(EVENT_CATALOG)
export const EVENT_CATEGORIES = ['video', 'access', 'intrusion', 'system']
// Objetivos clasificados por la cámara (filtrado de falsas alarmas).
export const TARGETS = ['human', 'vehicle', 'none']

export const DEVICE_TYPES = [
  { value: 'hikvision', label: 'Hikvision' },
  { value: 'akuvox',    label: 'Akuvox' },
  { value: 'nvr',       label: 'NVR' },
  { value: 'alarm',     label: 'Central de alarma' },
  { value: 'generic',   label: 'Genérico' },
]

// Pista de webhook por tipo de dispositivo (endpoint de ingesta).
export function webhookHint(type) {
  switch (type) {
    case 'hikvision': return '/api/ingest/hikvision'
    case 'akuvox':    return '/api/ingest/akuvox'
    case 'nvr':       return '/api/ingest/nvr'
    case 'alarm':     return '/api/ingest/alarm'
    default:          return '/api/ingest/generic'
  }
}
