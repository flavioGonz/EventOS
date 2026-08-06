// Dispositivo — página de edición dedicada (antes era un modal).
import { useEffect, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { Field, TextInput, Select, Combobox, Switch, Button, Icon, InfoHint } from '../ui/primitives.jsx'
import { collectionApi, unwrap, DEVICE_TYPES, webhookHint, testDeviceAlert } from '../lib/adminApi.js'
import { deviceTypeLabel, priorityLabel, DEVICE_TYPE_ICON } from '../lib/labels.js'
import { EditPage, Loading, useToast } from './_shared.jsx'
import { Go2RtcView, AnalyticsLegend, useCameraAnalytics } from '../components/CameraLive.jsx'
import { EventTypeGrid } from './EventTypeGrid.jsx'
import DeviceHealth from './DeviceHealth.jsx'
import DeviceProbe from './DeviceProbe.jsx'

// Encabezado de sección con chip de icono de color, título, subtítulo y tooltip.
function SecHead({ icon, tone, title, sub, hint, action }) {
  return (
    <div className="dev-sec">
      <span className={`dev-chip t-${tone}`}><Icon name={icon} size={16} /></span>
      <div className="dev-sec__t">
        <span className="dev-sec__title">{title}{hint && <InfoHint side="right" content={hint} />}</span>
        {sub && <span className="dev-sec__sub">{sub}</span>}
      </div>
      {action && <div className="dev-sec__action">{action}</div>}
    </div>
  )
}

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
            <Field label={<><Icon name="flag" size={14} /> Prioridad de las alertas
              <InfoHint side="right" content={<>Con qué urgencia entra a la consola cada alerta de este dispositivo. Sobreescribe la del catálogo/regla.<span className="tt__eg">Ej.: una cámara de bóveda en P1 (crítico) suena y encabeza la cola; una de pasillo en P4.</span></>} /></>}
              hint="Sobreescribe la de la regla/catálogo.">
              <Select value={A.priority || ''} onChange={(e) => set({ priority: e.target.value ? Number(e.target.value) : null })}>
                <option value="">— Según regla —</option>
                {[1, 2, 3, 4, 5].map((p) => <option key={p} value={p}>{`P${p} · ${priorityLabel(p)}`}</option>)}
              </Select>
            </Field>
            {deviceType !== 'alarm' && (
              <Field label={<><Icon name="filter" size={14} /> Filtro por objetivo
                <InfoHint side="right" content={<>Descarta lo que la IA de la cámara no clasifique como persona o vehículo. Reduce muchísimo las falsas alarmas (ramas, sombras, animales).<span className="tt__eg">Ej.: «Solo personas» en un cruce de línea perimetral nocturno.</span></>} /></>}
                hint="Descarta lo que no sea persona/vehículo (menos falsas alarmas).">
                <Select value={target} onChange={(e) => set({ target: e.target.value })}>
                  {TARGET_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </Select>
              </Field>
            )}
          </div>

          <p className="section-label u-mt-14"><Icon name="clock" size={14} /> Horario del alertado
            <InfoHint side="right" content={<>En qué días y franja horaria este dispositivo genera alertas. Fuera de la ventana, los eventos se registran pero no alertan al operador. La ventana puede cruzar medianoche.<span className="tt__eg">Ej.: perímetro que solo alerta de 20:00 a 08:00, L a D.</span></>} /></p>
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
  const [tab, setTab] = useState('datos') // datos | alertas | medios | salud
  const [probing, setProbing] = useState(false)
  const isAlarm = form.type === 'alarm'
  const isNvr = form.type === 'nvr'
  // Vista previa del canal: solo para cámaras ya guardadas (necesita id + credenciales).
  const canPreview = !isNew && !isNvr && !isAlarm
  // Aside a la derecha: video (cámara guardada) o ficha contextual (alarma/NVR guardados).
  const hasAside = canPreview || (!isNew && (isAlarm || isNvr))
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
  const applyImport = (patch) => setForm((f) => ({ ...f, ...patch }))
  const canProbe = !isAlarm && !!(form.ip || '').trim() && !!(form.username || '').trim()
  const addRelay = () => setForm((f) => ({ ...f, relays: [...(f.relays || []), { name: '', output: '1' }] }))
  const updRelay = (i, patch) => setForm((f) => ({ ...f, relays: (f.relays || []).map((r, j) => (j === i ? { ...r, ...patch } : r)) }))
  const delRelay = (i) => setForm((f) => ({ ...f, relays: (f.relays || []).filter((_, j) => j !== i) }))
  const triggerRelay = async (r) => {
    if (!window.confirm(`¿Abrir "${r.name || 'relé'}" ahora? Esto acciona la salida física del equipo.`)) return
    try {
      const res = await fetch(`/api/device/${id}/relay`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ output: r.output, cmd: r.kind || 'open', confirmed: true, operatorId: 'admin' }) })
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

  const TABS = [
    { k: 'datos', icon: 'device', label: 'Datos' },
    { k: 'alertas', icon: 'bell', label: 'Alertas' },
    { k: 'medios', icon: 'video', label: 'Medios de video', hide: isAlarm },
    { k: 'salud', icon: 'gauge', label: 'Salud' },
  ]

  return (
    <EditPage title={isNew ? 'Nuevo dispositivo' : 'Editar dispositivo'}
      subtitle="Cámara, NVR o central que genera eventos hacia EventOS." onCancel={back} onSave={save} saving={saving}>
      <div className="subtabs dev-tabs">
        {TABS.filter((t) => !t.hide).map((t) => (
          <button type="button" key={t.k} className={`subtab${tab === t.k ? ' is-on' : ''}`} onClick={() => setTab(t.k)}>
            <Icon name={t.icon} size={15} /> {t.label}
          </button>
        ))}
      </div>

      {/* ===== Pestaña DATOS ===== */}
      {tab === 'datos' && (
        <div key="datos" className={`dev-premium anim-rise ${hasAside ? 'dev-premium--aside' : ''}`}>
          <div className="dev-form">
            {isNew && (
              <div className="dev-card span-all">
                <SecHead icon="shield" tone="id" title="¿Qué fabricante?"
                  sub="Preconfigura el tipo, los puertos y los endpoints/APIs correctos." />
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

            {!isAlarm && (
              <div className="dev-card dev-cta span-all">
                <div className="dev-cta__body">
                  <span className="dev-chip t-media"><Icon name="search" size={17} /></span>
                  <div className="dev-cta__txt">
                    <b>Test de conectividad e importación de recursos</b>
                    <p>Sondeá el equipo con estas credenciales y traé sus canales, analíticas y relés — con un paso a paso animado. {isNvr ? 'En un NVR podés crear un dispositivo por cada cámara.' : ''}</p>
                  </div>
                </div>
                <Button variant="primary" icon="search" disabled={!canProbe} onClick={() => setProbing(true)}>Probar e importar</Button>
              </div>
            )}

            <div className="dev-card span-all">
              <SecHead icon="device" tone="id" title="Identificación"
                sub="Cómo se identifica el equipo dentro de EventOS."
                hint={<>Datos para identificar el equipo dentro de EventOS. El <b>Tipo</b> define qué campos aplican: una <b>alarma</b> no tiene canal de video ni RTSP. El <b>Canal</b> es el número de cámara dentro de un NVR.<span className="tt__eg">Ej.: «Cámara Acceso Norte» · Hikvision · canal 1.</span></>} />
              <div className="dev-grid dev-grid--4">
                <Field label={<><Icon name="device" size={14} /> Nombre</>} className="span-2">
                  <TextInput autoFocus value={form.name} onChange={set('name')} placeholder={isAlarm ? 'Central de alarma Depósito' : 'Cámara Acceso Norte'} />
                </Field>
                <Field label={<><Icon name={DEVICE_TYPE_ICON[form.type] || 'camera'} size={14} /> Tipo</>}>
                  <Select value={form.type} onChange={onType}>
                    {DEVICE_TYPES.map((t) => <option key={t.value} value={t.value}>{deviceTypeLabel(t.value)}</option>)}
                  </Select>
                </Field>
                <Field label={<><Icon name="shield" size={14} /> Fabricante</>}>
                  <TextInput value={form.vendor} onChange={set('vendor')} placeholder="Hikvision" />
                </Field>
                <Field label={<><Icon name="globe" size={14} /> IP</>} className={isAlarm ? 'span-2' : ''}>
                  <TextInput value={form.ip} onChange={set('ip')} placeholder="192.168.99.50" />
                </Field>
                {!isAlarm && (
                  <Field label={<><Icon name="hash" size={14} /> Canal
                    <InfoHint side="right" content={<>Número de cámara dentro de un NVR/DVR. En una cámara IP suelta suele ser 1.<span className="tt__eg">Ej.: canal 5 = quinta cámara del grabador.</span></>} /></>}>
                    <TextInput type="number" min="0" value={form.channel ?? ''} onChange={set('channel')} placeholder="1" />
                  </Field>
                )}
                <Field label={<><Icon name="online" size={14} /> Estado</>}>
                  <Switch checked={form.enabled} onChange={(enabled) => setForm((f) => ({ ...f, enabled }))} label={form.enabled ? 'Activo' : 'Deshabilitado'} />
                </Field>
              </div>
            </div>

            <div className="dev-card">
              <SecHead icon="shield" tone="cred" title="Credenciales y puertos"
                sub="Usuario/clave del equipo (no de EventOS)."
                hint={<>Usuario y clave del propio equipo (los que usás para entrar a su web), <b>no</b> los de EventOS. El server los usa para armar el RTSP/snapshot y consultar estado por ISAPI — nunca viajan en la URL.<span className="tt__eg">Ej.: admin / ••• · RTSP 554 · ISAPI 80.</span></>} />
              <div className="dev-grid dev-grid--2">
                <Field label={<><Icon name="user" size={14} /> Usuario</>}>
                  <TextInput value={form.username || ''} onChange={set('username')} placeholder="admin" autoComplete="off" />
                </Field>
                <Field label={<><Icon name="shield" size={14} /> Contraseña</>}>
                  <TextInput type="password" value={form.password || ''} onChange={set('password')} placeholder="••••••••" autoComplete="new-password" />
                </Field>
                {!isAlarm && (
                  <Field label={<><Icon name="hash" size={14} /> Puerto RTSP</>} hint="554 por defecto.">
                    <TextInput type="number" value={form.rtspPort ?? ''} onChange={set('rtspPort')} placeholder="554" />
                  </Field>
                )}
                <Field label={<><Icon name="hash" size={14} /> Puerto ISAPI/HTTP</>} hint="80 por defecto (snapshot/estado).">
                  <TextInput type="number" value={form.isapiPort ?? ''} onChange={set('isapiPort')} placeholder="80" />
                </Field>
                {!isAlarm && (
                  <Field label={<><Icon name="globe" size={14} /> IP directa de cámara
                    <InfoHint side="right" content={<>Opcional. Si la cámara está detrás de un NVR pero la alcanzás por su <b>propia</b> IP (p. ej. por VPN), poné acá esa IP y el vivo sale <b>directo</b> de la cámara — más limpio y con menos latencia que pasar por el NVR.<span className="tt__eg">Ej.: 192.168.7.129</span></>} /></>} className="span-2"
                    hint="Opcional. Si está detrás de un NVR pero la alcanzás por su IP (VPN), poné acá su IP para el vivo DIRECTO.">
                    <TextInput value={form.camIp || ''} onChange={set('camIp')} placeholder="192.168.7.129" />
                  </Field>
                )}
              </div>
            </div>

            <div className="dev-card">
              <SecHead icon="site" tone="group" title="Agrupación y prioridad"
                sub="Cliente, prioridad base y zona."
                hint={<>El <b>Sitio</b> agrupa el equipo por cliente (afecta afinidad de despacho, informes y filtros). La <b>Prioridad por defecto</b> ordena la cola cuando ninguna regla dice otra cosa. La <b>Zona</b> es una etiqueta libre de ubicación.<span className="tt__eg">Ej.: Sitio «Centro Logístico» · P2 · Zona «Playa de camiones».</span></>} />
              <Field label={<><Icon name="building" size={14} /> Sitio / Cliente</>} hint="Agrupa el dispositivo por cliente. Escribe para buscar o crea uno nuevo aquí.">
                <Combobox value={form.siteId || ''} onChange={(v) => setForm((f) => ({ ...f, siteId: v }))}
                  options={[{ value: '', label: '— Sin sitio —' }, ...sites.map((s) => ({ value: s.id, label: s.name }))]}
                  placeholder="— Sin sitio —" searchPlaceholder="Buscar o crear sitio…" onCreate={createSite} createLabel="Crear sitio" />
              </Field>
              <div className="dev-grid dev-grid--2 u-mt-12">
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
            </div>

            <div className="dev-card span-all">
              <SecHead icon="route" tone="relay" title="Relés / Puertas" sub="Salidas físicas del equipo."
                hint={<>Salidas de relé del equipo para abrir puertas o accionar dispositivos. Definí un nombre y el número de salida; el botón «Abrir» acciona el relé físico (pide confirmación). Se puede disparar desde la consola del operador durante un evento.<span className="tt__eg">Ej.: «Portón principal» → salida 1.</span></>}
                action={!isAlarm && canProbe && <Button variant="ghost" size="sm" icon="search" onClick={() => setProbing(true)}>Detectar del equipo</Button>} />
              <p className="help-block">Definí nombre y nº de salida; «Abrir» acciona el relé y pide confirmación. {isNew && <b>Guardá el dispositivo primero.</b>}</p>
              <div className="relaylist">
                {(form.relays || []).length === 0 && (
                  <div className="relay-empty"><Icon name="route" size={16} /> Sin relés. Agregá uno manualmente o usá «Detectar del equipo».</div>
                )}
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
          </div>

          {/* Aside derecho: video (cámara) o ficha contextual (alarma / NVR) */}
          {canPreview && (
            <aside className="dev-aside">
              <SecHead icon="video" tone="media" title="Canal en vivo" sub={`Canal #${form.channel ?? '—'} + analíticas`} />
              <div className="device-preview__stage" style={{ aspectRatio: previewAspect }}>
                <Go2RtcView deviceId={id} rules={ana && ana.rules} space={ana && ana.space} onAspect={setPreviewAspect} />
              </div>
              {ana && ana.rules && ana.rules.length > 0
                ? <div className="device-preview__legend"><AnalyticsLegend rules={ana.rules} /></div>
                : <p className="help-block">Sin analíticas dibujadas en esta cámara (líneas/zonas).</p>}
              <p className="help-block">Vista en vivo del canal #{form.channel ?? '—'}. Las líneas de cruce y zonas de intrusión se dibujan sobre el video.</p>
            </aside>
          )}
          {!canPreview && hasAside && (
            <aside className="dev-aside dev-sidecard">
              <span className="dev-sidecard__ic"><Icon name={isAlarm ? 'siren' : 'device'} size={26} /></span>
              <p className="dev-sidecard__title">{isAlarm ? 'Central de alarma' : 'NVR / DVR'}</p>
              {isAlarm ? (
                <p className="dev-sidecard__txt">Este dispositivo no tiene canal de video. Reporta eventos por IP/HTTP (intrusión, pánico, sabotaje). Configurá qué eventos alertan y su prioridad en la pestaña <b>Alertas</b>, y las salidas físicas en <b>Relés</b>.</p>
              ) : (
                <p className="dev-sidecard__txt">Las alertas se configuran <b>por cámara</b>, no en el NVR: cada evento se atribuye a la cámara que lo generó. Usá <b>Probar e importar</b> para crear un dispositivo por canal, y mirá su estado en <b>Salud</b>.</p>
              )}
            </aside>
          )}
        </div>
      )}

      {probing && <DeviceProbe device={form} onClose={() => setProbing(false)} onImport={applyImport} toast={toast} />}

      {/* ===== Pestaña ALERTAS ===== */}
      {tab === 'alertas' && (
        <div key="alertas" className="dev-tabpane anim-rise">
          {isNvr ? (
            <div className="alertcfg__nvrnote">
              <Icon name="bell" size={18} />
              <div>
                <b>Las alertas se configuran por cámara, no en el NVR.</b>
                <p>Los eventos del NVR (cruce de línea, intrusión, etc.) se atribuyen a la <b>cámara</b> que los generó y usan la configuración de Alertas de esa cámara. Abrí cada cámara del NVR para ajustar qué eventos alertan, su prioridad, filtro por objetivo y horario.</p>
              </div>
            </div>
          ) : (
            <>
              <p className="section-label"><Icon name="bell" size={14} /> Alertas — cómo alerta este dispositivo
                <InfoHint side="right" content={<>Definí qué eventos de este equipo interrumpen al operador, con qué prioridad, con qué filtro de objetivo y en qué horario. Lo que apagues queda solo en analítica (no molesta). Probá que llega bien con «Probar alerta».<span className="tt__eg">Ej.: solo «Cruce de línea» + «Intrusión», solo personas, de noche.</span></>} /></p>
              <p className="help-block">Qué eventos disparan alerta, con qué prioridad, filtro por objetivo y en qué horario. Probá que llega bien a la consola con «Probar alerta».</p>
              <AlertsConfig deviceType={form.type} alerts={form.alerts}
                onChange={(alerts) => setForm((f) => ({ ...f, alerts }))}
                deviceId={id} isNew={isNew} toast={toast} />
            </>
          )}
        </div>
      )}

      {/* ===== Pestaña SALUD ===== */}
      {tab === 'salud' && (
        <div key="salud" className="dev-tabpane anim-rise">
          <p className="section-label"><Icon name="gauge" size={14} /> Salud del dispositivo
            <InfoHint side="right" content={<>Estado en vivo consultado por ISAPI. En NVR: uptime, CPU, memoria y estado de discos (RAID). En cámaras: conexión, modelo, resolución, FPS, bitrate y última alerta.<span className="tt__eg">Útil para detectar un disco degradado o una cámara caída antes de que falte grabación.</span></>} /></p>
          <p className="help-block">Estado en vivo por ISAPI. Para NVR: uptime, CPU, memoria y discos. Para cámaras: conexión, modelo, resolución, FPS, bitrate y última alerta.</p>
          <DeviceHealth device={form} isNew={isNew} />
        </div>
      )}

      {/* ===== Pestaña MEDIOS DE VIDEO ===== */}
      {tab === 'medios' && !isAlarm && (
        <div key="medios" className="dev-tabpane dev-tabpane--2 anim-rise">
          <div>
            <p className="section-label"><Icon name="video" size={14} /> Medios de video
              <InfoHint side="right" content={<>URLs opcionales para el Centro de Verificación en Vivo. El <b>stream</b> (HLS/MJPEG) tiene prioridad sobre el <b>snapshot</b>. El <b>RTSP</b> se usa para el playback del NVR. Normalmente el server las arma solo desde IP + credenciales; llená esto solo para forzar una URL específica.<span className="tt__eg">Ej. stream: https://cdn/cam1/index.m3u8</span></>} /></p>
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
          <div className="dev-card">
            <p className="section-label"><Icon name="link" size={14} /> Webhook de ingesta
              <InfoHint side="right" content={<>Dirección a la que este equipo debe enviar sus eventos (POST). La URL completa con el token de ingesta —lista para pegar en el equipo— vive ahora en <b>Configuración › Endpoints de ingesta</b>.</>} /></p>
            <div className="recep-token">
              <Icon name="link" size={16} />
              <code>{webhookHint(form.type)}</code>
            </div>
            <p className="help-block u-mt-12">
              Configura el dispositivo para enviar eventos a ese endpoint. La URL completa con token está en <b>Configuración › Endpoints de ingesta</b>.
            </p>
          </div>
        </div>
      )}
    </EditPage>
  )
}
