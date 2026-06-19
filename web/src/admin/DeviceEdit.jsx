// Dispositivo — página de edición dedicada (antes era un modal).
import { useEffect, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { Field, TextInput, Select, Combobox, Switch, Button, Icon } from '../ui/primitives.jsx'
import { collectionApi, unwrap, DEVICE_TYPES, webhookHint, testDeviceAlert } from '../lib/adminApi.js'
import { deviceTypeLabel, priorityLabel, DEVICE_TYPE_ICON } from '../lib/labels.js'
import { EditPage, Loading, useToast } from './_shared.jsx'
import { Go2RtcView, AnalyticsLegend, useCameraAnalytics } from '../components/CameraLive.jsx'
import { EventTypeGrid } from './EventTypeGrid.jsx'
import DeviceHealth from './DeviceHealth.jsx'

const EMPTY = {
  name: '', type: 'hikvision', vendor: '', ip: '', channel: 1,
  username: '', password: '', isapiPort: '', rtspPort: '', camIp: '',
  siteId: '', zone: '', streamUrl: '', snapshotUrl: '', rtspUrl: '',
  enabled: true, defaultPriority: null, tags: [], alerts: null,
}
const VENDOR_BY_TYPE = { hikvision: 'Hikvision', akuvox: 'Akuvox', nvr: 'NVR', alarm: 'Alarma', generic: '' }

// Catálogo de fabricantes: al elegir uno se preconfiguran tipo, puertos y se
// muestran los endpoints/APIs correctos. (Se irán sumando más.)
const MANUFACTURERS = [
  { id: 'Hikvision', label: 'Hikvision', icon: 'shield', type: 'hikvision', isapiPort: 80, rtspPort: 554,
    hint: 'Cámaras y NVR por ISAPI (HTTP) + RTSP 554. Eventos en vivo por alertStream. Paneles AX (Hybrid/Pro) por ISAPI SecurityCP (próximamente, con control de relé).' },
  { id: 'Dahua', label: 'Dahua', icon: 'shield', type: 'generic', isapiPort: 80, rtspPort: 554,
    hint: 'Cámaras/NVR por HTTP API + RTSP 554 (/cam/realmonitor). Eventos por webhook.' },
  { id: 'Akuvox', label: 'Akuvox', icon: 'speaker', type: 'akuvox', isapiPort: 80, rtspPort: 554,
    hint: 'Intercom / portero IP. Eventos por webhook; audio y apertura por SIP / relé.' },
  { id: 'SIP', label: 'Parlante / Intercom SIP', icon: 'speaker', type: 'generic', isapiPort: '', rtspPort: '',
    hint: 'Parlante o intercom IP por SIP (sip:) o teléfono (tel:). No genera eventos; se usa para audio/aviso. También podés cargarlos a nivel Sitio.' },
  { id: 'ONVIF', label: 'Genérico / ONVIF', icon: 'device', type: 'generic', isapiPort: 80, rtspPort: 554,
    hint: 'Cualquier cámara ONVIF (Perfil S/M). Descubrir por ONVIF; RTSP estándar.' },
]

// Tipos de evento que puede disparar cada clase de dispositivo (para la config de alertas).
const CAM_ALERT_TYPES = [
  ['line_crossing', 'Cruce de línea'], ['intrusion', 'Intrusión'],
  ['region_entrance', 'Entrada a zona'], ['region_exit', 'Salida de zona'],
  ['motion', 'Movimiento'], ['tamper', 'Sabotaje'], ['video_loss', 'Pérdida de video'],
]
const ALARM_ALERT_TYPES = [
  ['intrusion', 'Intrusión'], ['alarm', 'Pánico / alarma'],
  ['tamper_alarm', 'Sabotaje de central'], ['door_forced', 'Puerta forzada'],
]
const TARGET_OPTS = [
  ['any', 'Cualquiera'], ['human', 'Solo personas'], ['vehicle', 'Solo vehículos'], ['human_vehicle', 'Personas o vehículos'],
]
const DAYS = [[1, 'L'], [2, 'M'], [3, 'X'], [4, 'J'], [5, 'V'], [6, 'S'], [0, 'D']]
const fmtRel = (ts) => { if (!ts) return null; const m = Math.floor((Date.now() - new Date(ts).getTime()) / 60000); if (m < 1) return 'recién'; if (m < 60) return `hace ${m} min`; const h = Math.floor(m / 60); return h < 24 ? `hace ${h} h` : `hace ${Math.floor(h / 24)} d` }

// Sección "Alertas": qué eventos disparan, prioridad, objetivo, horario, + prueba.
function AlertsConfig({ deviceType, alerts, onChange, deviceId, isNew, toast }) {
  const [lastEv, setLastEv] = useState(null)
  const [testing, setTesting] = useState(false)
  const anaEnabled = !isNew && deviceType !== 'alarm' && deviceType !== 'nvr' && !!deviceId
  const ana = useCameraAnalytics(deviceId, anaEnabled)
  const ANA_MAP = { line: ['line_crossing', 'Cruce de línea'], field: ['intrusion', 'Intrusión'], entrance: ['region_entrance', 'Entrada a zona'], exiting: ['region_exit', 'Salida de zona'] }
  const detected = ana && ana.rules ? [...new Set(ana.rules.map((r) => r.type))].map((tp) => ANA_MAP[tp]).filter(Boolean) : []
  const A = alerts || {}
  const enabled = A.enabled !== false
  const types = A.types || {}
  const target = A.target || 'any'
  const sched = A.schedule || { mode: 'always' }
  const schedDays = Array.isArray(sched.days) ? sched.days : [1, 2, 3, 4, 5, 6, 0]
  const TYPES = deviceType === 'alarm' ? ALARM_ALERT_TYPES : CAM_ALERT_TYPES
  const set = (patch) => onChange({ ...A, ...patch })
  const setSched = (patch) => set({ schedule: { ...sched, ...patch } })

  useEffect(() => {
    if (isNew || !deviceId) return
    let alive = true
    fetch(`/api/camera/${deviceId}/info`).then((r) => (r.ok ? r.json() : null)).then((d) => { if (alive && d && d.lastEvent) setLastEv(d.lastEvent) }).catch(() => {})
    return () => { alive = false }
  }, [deviceId, isNew])

  const runTest = async () => {
    setTesting(true)
    try { const r = await testDeviceAlert(deviceId); toast(`Alerta de prueba enviada — aparece en la consola (P${r.priority})`) }
    catch (e) { toast(e.message || 'No se pudo enviar la prueba', 'error') }
    finally { setTesting(false) }
  }

  return (
    <div className="alertcfg">
      <div className="alertcfg__head">
        <Switch checked={enabled} onChange={(v) => set({ enabled: v })} label={enabled ? 'Alertado activo' : 'Alertado desactivado'} />
        {!isNew && (
          <div className="alertcfg__test">
            {lastEv && <span className="alertcfg__last"><Icon name="clock" size={12} /> Última alerta {fmtRel(lastEv.ts)}</span>}
            <Button variant="secondary" size="sm" icon="bolt" disabled={testing} onClick={runTest}>
              {testing ? 'Enviando…' : 'Probar alerta'}
            </Button>
          </div>
        )}
      </div>

      {enabled && (
        <>
          <p className="help-block u-mt-12">Qué eventos de este dispositivo generan alerta al operador. Lo apagado se ignora (solo queda en analítica).</p>
          {detected.length > 0 && (
            <div className="alertcfg__detected">
              <span className="alertcfg__detected-lbl"><Icon name="filter" size={13} /> Analíticas configuradas en esta cámara:</span>
              {detected.map(([k, l]) => <span key={k} className="badge badge--accent">{l}</span>)}
            </div>
          )}
          <EventTypeGrid types={TYPES.map((t) => t[0])} isOn={(v) => types[v] !== false}
            onToggle={(v) => set({ types: { ...types, [v]: !(types[v] !== false) } })} />

          <div className="form-grid form-grid--2 u-mt-14">
            <Field label={<><Icon name="flag" size={14} /> Prioridad de las alertas</>} hint="Sobreescribe la de la regla/catálogo.">
              <Select value={A.priority || ''} onChange={(e) => set({ priority: e.target.value ? Number(e.target.value) : null })}>
                <option value="">— Según regla —</option>
                {[1, 2, 3, 4, 5].map((p) => <option key={p} value={p}>{`P${p} · ${priorityLabel(p)}`}</option>)}
              </Select>
            </Field>
            {deviceType !== 'alarm' && (
              <Field label={<><Icon name="filter" size={14} /> Filtro por objetivo</>} hint="Descarta lo que no sea persona/vehículo (menos falsas alarmas).">
                <Select value={target} onChange={(e) => set({ target: e.target.value })}>
                  {TARGET_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </Select>
              </Field>
            )}
          </div>

          <p className="section-label u-mt-14"><Icon name="clock" size={14} /> Horario del alertado</p>
          <div className="alertcfg__sched">
            <Select value={sched.mode || 'always'} onChange={(e) => setSched({ mode: e.target.value })} className="alertcfg__mode">
              <option value="always">Siempre activo</option>
              <option value="window">Solo en una ventana horaria</option>
            </Select>
            {sched.mode === 'window' && (
              <div className="alertcfg__win">
                <div className="alertcfg__days">
                  {DAYS.map(([d, l]) => {
                    const on = schedDays.includes(d)
                    return <button type="button" key={d} className={`daybtn ${on ? 'is-on' : ''}`} aria-pressed={on}
                      onClick={() => setSched({ days: on ? schedDays.filter((x) => x !== d) : [...schedDays, d] })}>{l}</button>
                  })}
                </div>
                <div className="alertcfg__range">
                  <span>De</span>
                  <input type="time" className="input alertcfg__time" value={sched.from || '20:00'} onChange={(e) => setSched({ from: e.target.value })} />
                  <span>a</span>
                  <input type="time" className="input alertcfg__time" value={sched.to || '08:00'} onChange={(e) => setSched({ to: e.target.value })} />
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

export default function DeviceEdit() {
  const { id } = useParams()
  const isNew = !id || id === 'new'
  const navigate = useNavigate()
  const location = useLocation()
  const toast = useToast()
  const [form, setForm] = useState({ ...EMPTY, ...(location.state?.prefill || {}) })
  const [sites, setSites] = useState([])
  const [loading, setLoading] = useState(!isNew)
  const [saving, setSaving] = useState(false)
  const [previewAspect, setPreviewAspect] = useState('16 / 9')
  const [tab, setTab] = useState('datos') // datos | alertas | medios
  // Vista previa del canal: solo para cámaras ya guardadas (necesita id + credenciales).
  const canPreview = !isNew && form.type !== 'nvr' && form.type !== 'alarm'
  const ana = useCameraAnalytics(id, canPreview)

  useEffect(() => {
    collectionApi('sites').list().then((d) => setSites(unwrap(d, 'sites'))).catch(() => {})
  }, [])
  useEffect(() => {
    if (isNew) return
    let alive = true
    collectionApi('devices').get(id)
      .then((d) => { if (alive) setForm({ ...EMPTY, ...d }) })
      .catch((e) => toast(e.message || 'No se pudo cargar', 'error'))
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [id, isNew]) // eslint-disable-line react-hooks/exhaustive-deps

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))
  const onType = (e) => {
    const type = e.target.value
    setForm((f) => ({ ...f, type, vendor: f.vendor || VENDOR_BY_TYPE[type] || '' }))
  }
  const curMfr = MANUFACTURERS.find((m) => m.id === form.vendor) || null
  const pickMfr = (m) => setForm((f) => ({ ...f, vendor: m.id, type: m.type, isapiPort: m.isapiPort ?? f.isapiPort, rtspPort: m.rtspPort ?? f.rtspPort }))
  const createSite = async (name) => {
    const nm = (name || '').trim()
    if (!nm) return null
    try {
      const created = await collectionApi('sites').create({ name: nm })
      if (created && created.id) { setSites((p) => [...p, created]); toast(`Sitio «${nm}» creado`); return created.id }
    } catch (e) { toast(e.message, 'error') }
    return null
  }
  const back = () => navigate('/admin/devices')
  const addRelay = () => setForm((f) => ({ ...f, relays: [...(f.relays || []), { name: '', output: '1' }] }))
  const updRelay = (i, patch) => setForm((f) => ({ ...f, relays: (f.relays || []).map((r, j) => (j === i ? { ...r, ...patch } : r)) }))
  const delRelay = (i) => setForm((f) => ({ ...f, relays: (f.relays || []).filter((_, j) => j !== i) }))
  const triggerRelay = async (r) => {
    if (!window.confirm(`¿Abrir "${r.name || 'relé'}" ahora? Esto acciona la salida física del equipo.`)) return
    try {
      const res = await fetch(`/api/device/${id}/relay`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ output: r.output, kind: r.kind }) })
      const d = await res.json()
      if (d.ok) toast(`Relé accionado — ${r.name || 'salida ' + r.output}`)
      else toast(`El equipo no respondió OK (${d.status || d.error || '—'})`, 'error')
    } catch (e) { toast(e.message || 'No se pudo accionar el relé', 'error') }
  }
  const save = async () => {
    if (!form.name.trim()) { toast('El nombre es obligatorio', 'error'); return }
    setSaving(true)
    const payload = {
      ...form,
      channel: form.channel === '' || form.channel == null ? null : Number(form.channel),
      defaultPriority: form.defaultPriority ? Number(form.defaultPriority) : null,
      isapiPort: form.isapiPort ? Number(form.isapiPort) : null,
      rtspPort: form.rtspPort ? Number(form.rtspPort) : null,
      camIp: (form.camIp || '').trim() || null,
      siteId: form.siteId || null,
    }
    try {
      if (isNew) await collectionApi('devices').create(payload)
      else await collectionApi('devices').update(id, payload)
      toast('Dispositivo guardado'); back()
    } catch (e) { toast(e.message, 'error'); setSaving(false) }
  }

  if (loading) return <Loading label="Cargando dispositivo…" />

  return (
    <EditPage title={isNew ? 'Nuevo dispositivo' : 'Editar dispositivo'}
      subtitle="Cámara, NVR o central que genera eventos hacia EventOS." onCancel={back} onSave={save} saving={saving}>
      <div className="subtabs dev-tabs">
        <button type="button" className={`subtab${tab === 'datos' ? ' is-on' : ''}`} onClick={() => setTab('datos')}>
          <Icon name="device" size={15} /> Datos
        </button>
        <button type="button" className={`subtab${tab === 'alertas' ? ' is-on' : ''}`} onClick={() => setTab('alertas')}>
          <Icon name="bell" size={15} /> Alertas
        </button>
        <button type="button" className={`subtab${tab === 'medios' ? ' is-on' : ''}`} onClick={() => setTab('medios')}>
          <Icon name="video" size={15} /> Medios de video
        </button>
        <button type="button" className={`subtab${tab === 'salud' ? ' is-on' : ''}`} onClick={() => setTab('salud')}>
          <Icon name="gauge" size={15} /> Salud
        </button>
      </div>

      <div className="device-modal device-modal--2col" hidden={tab !== 'datos'}>
        <div className="device-modal__main">
          {isNew && (
            <div className="mfr-pick">
              <p className="section-label"><Icon name="shield" size={14} /> ¿Qué fabricante?</p>
              <p className="help-block">Elegí el fabricante para preconfigurar el tipo, los puertos y los endpoints/APIs correctos.</p>
              <div className="mfr-grid">
                {MANUFACTURERS.map((m) => (
                  <button type="button" key={m.id} className={`mfr-card${form.vendor === m.id ? ' is-on' : ''}`} onClick={() => pickMfr(m)}>
                    <span className="mfr-card__ic"><Icon name={m.icon} size={20} /></span>
                    <span className="mfr-card__lbl">{m.label}</span>
                  </button>
                ))}
              </div>
              {curMfr && <div className="mfr-hint"><Icon name="bell" size={14} /> <span>{curMfr.hint}</span></div>}
            </div>
          )}
          <p className="section-label"><Icon name="device" size={14} /> Identificación</p>
          <div className="form-grid form-grid--2">
            <Field label={<><Icon name="device" size={14} /> Nombre</>} className="span-2">
              <TextInput autoFocus value={form.name} onChange={set('name')} placeholder="Cámara Acceso Norte" />
            </Field>
            <Field label={<><Icon name={DEVICE_TYPE_ICON[form.type] || 'camera'} size={14} /> Tipo</>}>
              <Select value={form.type} onChange={onType}>
                {DEVICE_TYPES.map((t) => <option key={t.value} value={t.value}>{deviceTypeLabel(t.value)}</option>)}
              </Select>
            </Field>
            <Field label={<><Icon name="shield" size={14} /> Fabricante</>}>
              <TextInput value={form.vendor} onChange={set('vendor')} placeholder="Hikvision" />
            </Field>
            <Field label={<><Icon name="globe" size={14} /> IP</>}>
              <TextInput value={form.ip} onChange={set('ip')} placeholder="192.168.99.50" />
            </Field>
            <Field label={<><Icon name="hash" size={14} /> Canal</>}>
              <TextInput type="number" min="0" value={form.channel ?? ''} onChange={set('channel')} placeholder="1" />
            </Field>
          </div>

          <p className="section-label u-mt-14"><Icon name="shield" size={14} /> Credenciales y puertos</p>
          <p className="help-block">Usuario y clave del equipo (no van en la URL). El server arma el RTSP/snapshot con esto.</p>
          <div className="form-grid form-grid--2">
            <Field label={<><Icon name="user" size={14} /> Usuario</>}>
              <TextInput value={form.username || ''} onChange={set('username')} placeholder="admin" autoComplete="off" />
            </Field>
            <Field label={<><Icon name="shield" size={14} /> Contraseña</>}>
              <TextInput type="password" value={form.password || ''} onChange={set('password')} placeholder="••••••••" autoComplete="new-password" />
            </Field>
            <Field label={<><Icon name="hash" size={14} /> Puerto RTSP</>} hint="554 por defecto.">
              <TextInput type="number" value={form.rtspPort ?? ''} onChange={set('rtspPort')} placeholder="554" />
            </Field>
            <Field label={<><Icon name="hash" size={14} /> Puerto ISAPI/HTTP</>} hint="80 por defecto (snapshot/estado).">
              <TextInput type="number" value={form.isapiPort ?? ''} onChange={set('isapiPort')} placeholder="80" />
            </Field>
            <Field label={<><Icon name="globe" size={14} /> IP directa de cámara</>} className="span-2"
              hint="Opcional. Si la cámara está detrás de un NVR pero la alcanzás por su IP (VPN), poné acá su IP para el vivo DIRECTO (limpio).">
              <TextInput value={form.camIp || ''} onChange={set('camIp')} placeholder="192.168.7.129" />
            </Field>
          </div>

          <p className="section-label u-mt-14"><Icon name="site" size={14} /> Agrupación y prioridad</p>
          <Field label={<><Icon name="building" size={14} /> Sitio / Cliente</>} hint="Agrupa el dispositivo por cliente. Escribe para buscar o crea uno nuevo aquí.">
            <Combobox value={form.siteId || ''} onChange={(v) => setForm((f) => ({ ...f, siteId: v }))}
              options={[{ value: '', label: '— Sin sitio —' }, ...sites.map((s) => ({ value: s.id, label: s.name }))]}
              placeholder="— Sin sitio —" searchPlaceholder="Buscar o crear sitio…" onCreate={createSite} createLabel="Crear sitio" />
          </Field>
          <div className="form-grid form-grid--2 u-mt-12">
            <Field label={<><Icon name="flag" size={14} /> Prioridad por defecto</>} hint="Opcional. Sobrescribe la del catálogo (1–5).">
              <Select value={form.defaultPriority ?? ''} onChange={set('defaultPriority')}>
                <option value="">— Catálogo —</option>
                {[1, 2, 3, 4, 5].map((p) => <option key={p} value={p}>{`P${p} · ${priorityLabel(p)}`}</option>)}
              </Select>
            </Field>
            <Field label={<><Icon name="pin" size={14} /> Zona</>} hint="Etiqueta de ubicación (p. ej. «Acceso Norte»).">
              <TextInput value={form.zone || ''} onChange={set('zone')} placeholder="Acceso Norte" />
            </Field>
          </div>
          <Field label={<><Icon name="online" size={14} /> Estado</>} className="u-mt-12">
            <Switch checked={form.enabled} onChange={(enabled) => setForm((f) => ({ ...f, enabled }))} label={form.enabled ? 'Activo' : 'Deshabilitado'} />
          </Field>

          <p className="section-label u-mt-14"><Icon name="route" size={14} /> Relés / Puertas <span className="muted">· salidas físicas</span></p>
          <p className="help-block">Salidas del equipo para abrir puertas (relé IP). Definí nombre y nº de salida; «Abrir» acciona el relé y pide confirmación. {isNew && <b>Guardá el dispositivo primero.</b>}</p>
          <div className="relaylist">
            {(form.relays || []).map((r, i) => (
              <div className="relayrow" key={i}>
                <TextInput value={r.name || ''} placeholder="Puerta principal" onChange={(e) => updRelay(i, { name: e.target.value })} />
                <TextInput type="number" min="1" className="relayrow__out" value={r.output ?? '1'} placeholder="1" onChange={(e) => updRelay(i, { output: e.target.value })} />
                <Button variant="secondary" icon="route" disabled={isNew} onClick={() => triggerRelay(r)}>Abrir</Button>
                <Button variant="ghost" onClick={() => delRelay(i)}>Quitar</Button>
              </div>
            ))}
            <Button variant="ghost" icon="plus" onClick={addRelay}>Agregar relé / puerta</Button>
          </div>
        </div>

        {/* Vista previa del canal en vivo + analíticas (pestaña Datos) */}
        <aside className="device-modal__preview">
          <p className="section-label"><Icon name="video" size={14} /> Canal en vivo + analíticas</p>
          {canPreview ? (
            <>
              <div className="device-preview__stage" style={{ aspectRatio: previewAspect }}>
                <Go2RtcView deviceId={id} rules={ana && ana.rules} space={ana && ana.space} onAspect={setPreviewAspect} />
              </div>
              {ana && ana.rules && ana.rules.length > 0
                ? <div className="device-preview__legend"><AnalyticsLegend rules={ana.rules} /></div>
                : <p className="help-block">Sin analíticas dibujadas en esta cámara (líneas/zonas).</p>}
              <p className="help-block">Vista en vivo del canal #{form.channel ?? '—'}. Las líneas de cruce y zonas de intrusión se dibujan sobre el video.</p>
            </>
          ) : (
            <div className="device-preview__empty">
              <Icon name="video" size={22} />
              <span>{isNew
                ? 'Guarda el dispositivo para ver el video del canal.'
                : 'Sin canal de video para este tipo de dispositivo.'}</span>
            </div>
          )}
        </aside>
      </div>

      {/* ===== Pestaña ALERTAS ===== */}
      <div className="dev-tabpane" hidden={tab !== 'alertas'}>
        {form.type === 'nvr' ? (
          <div className="alertcfg__nvrnote">
            <Icon name="bell" size={18} />
            <div>
              <b>Las alertas se configuran por cámara, no en el NVR.</b>
              <p>Los eventos del NVR (cruce de línea, intrusión, etc.) se atribuyen a la <b>cámara</b> que los generó y usan la configuración de Alertas de esa cámara. Abrí cada cámara del NVR para ajustar qué eventos alertan, su prioridad, filtro por objetivo y horario.</p>
            </div>
          </div>
        ) : (
          <>
            <p className="section-label"><Icon name="bell" size={14} /> Alertas — cómo alerta este dispositivo</p>
            <p className="help-block">Qué eventos disparan alerta, con qué prioridad, filtro por objetivo y en qué horario. Probá que llega bien a la consola con «Probar alerta».</p>
            <AlertsConfig deviceType={form.type} alerts={form.alerts}
              onChange={(alerts) => setForm((f) => ({ ...f, alerts }))}
              deviceId={id} isNew={isNew} toast={toast} />
          </>
        )}
      </div>

      {/* ===== Pestaña SALUD ===== */}
      <div className="dev-tabpane" hidden={tab !== 'salud'}>
        <p className="section-label"><Icon name="gauge" size={14} /> Salud del dispositivo</p>
        <p className="help-block">Estado en vivo por ISAPI. Para NVR: uptime, CPU, memoria y discos. Para cámaras: conexión, modelo, resolución, FPS, bitrate y última alerta.</p>
        {tab === 'salud' && <DeviceHealth device={form} isNew={isNew} />}
      </div>

      {/* ===== Pestaña MEDIOS DE VIDEO ===== */}
      <div className="dev-tabpane dev-tabpane--2" hidden={tab !== 'medios'}>
        <div>
          <p className="section-label"><Icon name="video" size={14} /> Medios de video</p>
          <p className="help-block">Para el Centro de Verificación en Vivo. El stream tiene prioridad sobre el snapshot.</p>
          <Field label={<><Icon name="video" size={14} /> URL de stream</>} hint="HLS (.m3u8) o imagen (MJPEG).">
            <TextInput value={form.streamUrl || ''} onChange={set('streamUrl')} placeholder="https://cdn.ejemplo.com/cam1/index.m3u8" />
          </Field>
          <Field label={<><Icon name="camera" size={14} /> URL de snapshot</>} hint="JPEG que se refresca en el muro." className="u-mt-12">
            <TextInput value={form.snapshotUrl || ''} onChange={set('snapshotUrl')} placeholder="https://cdn.ejemplo.com/cam1/snapshot.jpg" />
          </Field>
          <Field label={<><Icon name="video" size={14} /> URL RTSP (playback NVR)</>} hint="Base RTSP con credenciales. Ej: rtsp://user:pass@ip:554" className="u-mt-12">
            <TextInput value={form.rtspUrl || ''} onChange={set('rtspUrl')} placeholder="rtsp://user:pass@192.168.1.10:554" />
          </Field>
        </div>
        <div>
          <p className="section-label"><Icon name="link" size={14} /> Webhook de ingesta</p>
          <div className="recep-token">
            <Icon name="link" size={16} />
            <code>{webhookHint(form.type)}</code>
          </div>
          <p className="help-block u-mt-12">
            Configura el dispositivo para enviar eventos a ese endpoint. La URL completa con token aparece en <b>Recepción</b>.
          </p>
        </div>
      </div>
    </EditPage>
  )
}
