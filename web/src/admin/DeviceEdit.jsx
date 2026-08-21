// Dispositivo — página de edición dedicada (antes era un modal).
import { useEffect, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { Field, TextInput, Select, Combobox, Switch, Segmented, Button, Icon, InfoHint } from '../ui/primitives.jsx'
import { collectionApi, unwrap, DEVICE_TYPES, webhookHint, testDeviceAlert, normalizeDeviceType, getReception } from '../lib/adminApi.js'
import { deviceTypeLabel, priorityLabel, DEVICE_TYPE_ICON } from '../lib/labels.js'
import { EditPage, Loading, useToast } from './_shared.jsx'
import { Go2RtcView, AnalyticsLabels, useCameraAnalytics, refreshCameraAnalytics } from '../components/CameraLive.jsx'
import AnalyticsEditor from './AnalyticsEditor.jsx'
import DeviceCaptures from './DeviceCaptures.jsx'
import { EventTypeGrid } from './EventTypeGrid.jsx'
import { EVENT_TYPE_ICON } from '../lib/labels.js'
import DeviceHealth from './DeviceHealth.jsx'
import DeviceLogs from './DeviceLogs.jsx'
import DeviceProbe from './DeviceProbe.jsx'
import AlarmPanel from './AlarmPanel.jsx'
import { VendorLogo, VENDOR_BRANDS } from '../ui/vendorLogos.jsx'
import AkuvoxActionUrls from './AkuvoxActionUrls.jsx'
import AkuvoxUsers from './AkuvoxUsers.jsx'

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
  name: '', type: 'camera', vendor: '', ip: '', channel: 1,
  username: '', password: '', isapiPort: '', rtspPort: '', camIp: '',
  siteId: '', zone: '', area: '', liveSource: 'auto', playbackSource: 'nvr', videoMode: 'transcode', streamUrl: '', snapshotUrl: '', rtspUrl: '',
  enabled: true, defaultPriority: null, tags: [], alerts: null, armed: false, relays: [],
}
const VENDORS = ['Hikvision', 'Dahua', 'Tiandy', 'Akuvox', 'Uniview', 'Siera', 'Intelbras', 'ONVIF', 'Otro']
const TYPE_DESC = {
  camera: 'RTSP + eventos (ISAPI / ONVIF).',
  nvr: 'Grabador · varias cámaras por canal.',
  alarm: 'Central · reporta por IP/HTTP, sin video.',
  intercom: 'Portero IP · video, audio y relé.',
  access: 'Puertas / relés y eventos de acceso.',
}

// Catálogo de fabricantes: al elegir uno se preconfiguran tipo, puertos y se
// muestran los endpoints/APIs correctos. (Se irán sumando más.)
const MANUFACTURERS = [
  { id: 'Hikvision', label: 'Hikvision', icon: 'shield', type: 'hikvision', isapiPort: 80, rtspPort: 554,
    hint: 'Cámaras y NVR por ISAPI (HTTP) + RTSP 554. Eventos en vivo por alertStream. Paneles AX (Hybrid/Pro) por ISAPI SecurityCP (próximamente, con control de relé).' },
  { id: 'Tiandy', label: 'Tiandy', icon: 'device', type: 'nvr', isapiPort: 80, rtspPort: 554,
    hint: 'NVR/cámaras Tiandy. Vivo por RTSP (/Streaming/Channels o /media/…) y descubrimiento por ONVIF (Perfil S). Eventos por webhook/ONVIF. No usa ISAPI de Hikvision.' },
  { id: 'Dahua', label: 'Dahua', icon: 'shield', type: 'generic', isapiPort: 80, rtspPort: 554,
    hint: 'Cámaras/NVR por HTTP API + RTSP 554 (/cam/realmonitor). Eventos por webhook.' },
  { id: 'Akuvox', label: 'Akuvox', icon: 'speaker', type: 'akuvox', isapiPort: 80, rtspPort: 554,
    hint: 'Intercom / portero IP. Eventos por webhook; audio y apertura por SIP / relé.' },
  { id: 'Uniview', label: 'Uniview (UNV)', icon: 'device', type: 'generic', isapiPort: 80, rtspPort: 554,
    hint: 'Cámaras y NVR UNV. Vivo por RTSP 554 (/media/{ch}/...) y descubrimiento por ONVIF (Perfil S). Eventos por ONVIF/webhook. No usa ISAPI de Hikvision.' },
  { id: 'Siera', label: 'Siera', icon: 'shield', type: 'generic', isapiPort: 80, rtspPort: 554,
    hint: 'Cámaras/NVR Siera por RTSP 554 y ONVIF (Perfil S). Descubrimiento y eventos por ONVIF/webhook.' },
  { id: 'Intelbras', label: 'Intelbras', icon: 'shield', type: 'generic', isapiPort: 80, rtspPort: 554,
    hint: 'Cámaras/NVR Intelbras (base Dahua). RTSP 554 (/cam/realmonitor) + HTTP API. Eventos por webhook.' },
  { id: 'SIP', label: 'Parlante / Intercom SIP', icon: 'speaker', type: 'generic', isapiPort: '', rtspPort: '',
    hint: 'Parlante o intercom IP por SIP (sip:) o teléfono (tel:). No genera eventos; se usa para audio/aviso. También podés cargarlos a nivel Sitio.' },
  { id: 'ONVIF', label: 'Genérico / ONVIF', icon: 'device', type: 'generic', isapiPort: 80, rtspPort: 554,
    hint: 'Cualquier cámara ONVIF (Perfil S/M). Descubrir por ONVIF; RTSP estándar.' },
]

// Pasos del alta guiada (riel de progreso animado).
const WIZ_STEPS = [
  { k: 'marca', lbl: 'Marca', icon: 'shield' },
  { k: 'tipo', lbl: 'Tipo', icon: 'grid' },
  { k: 'conexion', lbl: 'Conexión', icon: 'globe' },
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
  ['door_open', 'Puerta abierta'],
]
const INTERCOM_ALERT_TYPES = [
  ['call', 'Llamada de portero'], ['door_open', 'Puerta abierta'], ['tamper', 'Sabotaje'],
]
const ACCESS_ALERT_TYPES = [
  ['access_denied', 'Acceso denegado'], ['access_granted', 'Acceso concedido'],
  ['door_forced', 'Puerta forzada'], ['door_held', 'Puerta mantenida abierta'],
]
// Tipos de evento ofrecidos SEGÚN el tipo de dispositivo (capacidad real): una
// alarma no ofrece cruce de línea; un portero no ofrece analíticas de video.
function alertTypesFor(deviceType) {
  if (deviceType === 'alarm') return ALARM_ALERT_TYPES
  if (deviceType === 'intercom') return INTERCOM_ALERT_TYPES
  if (deviceType === 'access') return ACCESS_ALERT_TYPES
  return CAM_ALERT_TYPES // camera / nvr
}
const TARGET_OPTS = [
  ['any', 'Cualquiera'], ['human', 'Solo personas'], ['vehicle', 'Solo vehículos'], ['human_vehicle', 'Personas o vehículos'],
]
const DAYS = [[1, 'L'], [2, 'M'], [3, 'X'], [4, 'J'], [5, 'V'], [6, 'S'], [0, 'D']]
const fmtRel = (ts) => { if (!ts) return null; const m = Math.floor((Date.now() - new Date(ts).getTime()) / 60000); if (m < 1) return 'recién'; if (m < 60) return `hace ${m} min`; const h = Math.floor(m / 60); return h < 24 ? `hace ${h} h` : `hace ${Math.floor(h / 24)} d` }

// Sección "Alertas": qué eventos disparan, prioridad, objetivo, horario, + prueba.
function AlertsConfig({ deviceType, alerts, onChange, deviceId, isNew, toast, split = false }) {
  const [lastEv, setLastEv] = useState(null)
  const [testing, setTesting] = useState(false)
  const [previewAspect, setPreviewAspect] = useState(null)
  const anaEnabled = !isNew && deviceType !== 'alarm' && deviceType !== 'nvr' && !!deviceId
  const ana = useCameraAnalytics(deviceId, anaEnabled)
  const ANA_MAP = { line: ['line_crossing', 'Cruce de línea'], field: ['intrusion', 'Intrusión'], entrance: ['region_entrance', 'Entrada a zona'], exiting: ['region_exit', 'Salida de zona'], baggage: ['abandoned_object', 'Objeto abandonado'], takenaway: ['object_removal', 'Objeto retirado'] }
  const anaRules = (ana && ana.rules) || []
  // Analíticas detectadas en el equipo, con conteo por tipo.
  const detected = [...new Set(anaRules.map((r) => r.type))]
    .map((tp) => (ANA_MAP[tp] ? [ANA_MAP[tp][0], ANA_MAP[tp][1], anaRules.filter((r) => r.type === tp).length] : null))
    .filter(Boolean)
  const ANALYTIC_CATALOG = new Set(['line_crossing', 'intrusion', 'region_entrance', 'region_exit', 'abandoned_object', 'object_removal'])
  const configuredSet = new Set(detected.map(([k]) => k))
  const anaStatus = (val) => {
    if (!ANALYTIC_CATALOG.has(val)) return null
    return configuredSet.has(val) ? { label: 'dibujada', tone: 'ok' } : { label: 'sin dibujar', tone: 'warn' }
  }
  const A = alerts || {}
  const enabled = A.enabled !== false
  const types = A.types || {}
  const target = A.target || 'any'
  const sched = A.schedule || { mode: 'always' }
  const schedDays = Array.isArray(sched.days) ? sched.days : [1, 2, 3, 4, 5, 6, 0]
  const TYPES = alertTypesFor(deviceType)
  const showTargetFilter = deviceType === 'camera' || deviceType === 'nvr'
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

  const aside = (
    <aside className="alertcfg__aside">
      {detected.length > 0 && (
        <div className="anapanel">
          <div className="anapanel__hd"><Icon name="filter" size={14} /> Analíticas en el dispositivo <span className="anapanel__n">{detected.length}</span></div>
          <ul className="anapanel__list">
            {detected.map(([k, l, n]) => (
              <li key={k} className="anapanel__it">
                <span className="anapanel__ic"><Icon name={EVENT_TYPE_ICON[k] || 'bolt'} size={15} /></span>
                <span className="anapanel__lbl">{l}</span>
                {n > 1 ? <span className="anapanel__cnt" title={`${n} reglas`}>{n}</span> : null}
                <span className="anapanel__ok" title="Dibujada en el equipo"><Icon name="check" size={12} /></span>
              </li>
            ))}
          </ul>
          <p className="anapanel__hint">Dibujadas hoy en el equipo. Marcá en la tabla cuáles alertan al operador.</p>
        </div>
      )}
      <div className="anapanel anapanel--cfg">
        <Field label={<><Icon name="flag" size={14} /> Prioridad de las alertas
          <InfoHint side="left" content={<>Con qué urgencia entra a la consola cada alerta de este dispositivo. Sobreescribe la del catálogo/regla.<span className="tt__eg">Ej.: una cámara de bóveda en P1 (crítico) encabeza la cola; una de pasillo en P4.</span></>} /></>}
          hint="Sobreescribe la de la regla/catálogo.">
          <Select value={A.priority || ''} onChange={(e) => set({ priority: e.target.value ? Number(e.target.value) : null })}>
            <option value="">— Según regla —</option>
            {[1, 2, 3, 4, 5].map((p) => <option key={p} value={p}>{`P${p} · ${priorityLabel(p)}`}</option>)}
          </Select>
        </Field>
        {showTargetFilter && (
          <Field label={<><Icon name="filter" size={14} /> Filtro por objetivo
            <InfoHint side="left" content={<>Descarta lo que la IA de la cámara no clasifique como persona o vehículo. Reduce muchísimo las falsas alarmas (ramas, sombras, animales).<span className="tt__eg">Ej.: «Solo personas» en un cruce de línea perimetral nocturno.</span></>} /></>}
            hint="Descarta lo que no sea persona/vehículo.">
            <Select value={target} onChange={(e) => set({ target: e.target.value })}>
              {TARGET_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
          </Field>
        )}
        <p className="section-label u-mt-6"><Icon name="clock" size={14} /> Horario del alertado
          <InfoHint side="left" content={<>En qué días y franja horaria este dispositivo genera alertas. Fuera de la ventana, los eventos se registran pero no alertan. La ventana puede cruzar medianoche.<span className="tt__eg">Ej.: perímetro que solo alerta de 20:00 a 08:00, L a D.</span></>} /></p>
        <div className="alertcfg__sched">
          <Select value={sched.mode || 'always'} onChange={(e) => setSched({ mode: e.target.value })} className="alertcfg__mode">
            <option value="always">Siempre activo</option>
            <option value="window">Solo en una ventana horaria</option>
          </Select>
          {sched.mode === 'window' && (
            <div className="alertcfg__win">
              <div className="alertcfg__days">
                {DAYS.map(([dd, l]) => {
                  const on = schedDays.includes(dd)
                  return <button type="button" key={dd} className={`daybtn ${on ? 'is-on' : ''}`} aria-pressed={on}
                    onClick={() => setSched({ days: on ? schedDays.filter((x) => x !== dd) : [...schedDays, dd] })}>{l}</button>
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
      </div>
    </aside>
  )

  const showPreview = split && !isNew && !!deviceId && deviceType === 'camera'
  return (
    <div className={`alertcfg ${enabled && split ? 'alertcfg--split' : ''} ${enabled && showPreview ? 'alertcfg--3col' : ''}`}>
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
          <div className="alertcfg__main">
            <p className="help-block">
              Marcá qué eventos de este equipo <b>alertan al operador</b>. Es distinto de lo que la cámara tiene <b>dibujado</b>:
              una analítica <span className="etrow__tag t-warn" style={{ position: 'static' }}>○ sin dibujar</span> no
              generará eventos hasta que la dibujes en la cámara (botón <b>«Editar»</b> sobre el video, en la pestaña Datos).
              Pasá el mouse por cada fila para ver cómo funciona.
            </p>
            <EventTypeGrid layout="table" types={TYPES.map((t) => t[0])} isOn={(v) => types[v] !== false} status={anaStatus}
              onToggle={(v) => set({ types: { ...types, [v]: !(types[v] !== false) } })} />
          </div>
          {aside}
          {showPreview && (
            <div className="alertcfg__preview" style={previewAspect ? { aspectRatio: previewAspect } : undefined}>
              <Go2RtcView deviceId={deviceId} rules={anaRules.length ? anaRules : null} space={(ana && ana.space) || 1000} onAspect={setPreviewAspect} />
              <span className="alertcfg__preview-tag"><Icon name="video" size={11} /> Vivo · analíticas</span>
            </div>
          )}
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
  const [allDevices, setAllDevices] = useState([])
  const [loading, setLoading] = useState(!isNew)
  const [saving, setSaving] = useState(false)
  const [previewAspect, setPreviewAspect] = useState('16 / 9')
  const [videoReady, setVideoReady] = useState(false)
  const [liveQuality, setLiveQuality] = useState('sub') // 'sub' | 'main' — flujo elegido
  const [editingAna, setEditingAna] = useState(false)
  const [tab, setTab] = useState('datos') // datos | alertas | medios | salud
  const [tabCounts, setTabCounts] = useState({ logs: null, usuarios: null }) // contadores async para los badges
  const [probing, setProbing] = useState(false)
  const [probed, setProbed] = useState(false) // conexión verificada al menos una vez
  const [newStep, setNewStep] = useState(0) // alta: 0=Marca 1=Tipo 2=Conexión
  const isAlarm = form.type === 'alarm'
  const isNvr = form.type === 'nvr'
  const isAccess = form.type === 'access'
  const isIntercom = form.type === 'intercom'
  const isCamera = form.type === 'camera'
  // Vista previa del canal: cámara/portero ya guardados (necesita id + credenciales).
  const canPreview = !isNew && (isCamera || isIntercom)
  // Aside a la derecha: video (cámara guardada) o ficha contextual (alarma/NVR guardados).
  const hasAside = canPreview || (!isNew && isNvr)
  // ¿El equipo puede tener relés/salidas físicas? (todos menos NVR puro).
  const hasRelays = !isNvr
  const ana = useCameraAnalytics(id, canPreview)

  const reloadDevices = () => collectionApi('devices').list().then((d) => setAllDevices(unwrap(d, 'devices'))).catch(() => {})
  useEffect(() => {
    collectionApi('sites').list().then((d) => setSites(unwrap(d, 'sites'))).catch(() => {})
    reloadDevices()
  }, [])
  // URL de webhook de ingesta para equipos que reportan por HTTP (alarma / acceso).
  const [ingestUrl, setIngestUrl] = useState('')
  useEffect(() => {
    if (isNew || !(isAlarm || isAccess) || !id) return
    let alive = true
    getReception().then((d) => {
      if (!alive) return
      const rec = (d.devices || []).find((x) => x.id === id)
      setIngestUrl(rec ? (rec.urlWithToken || rec.url || '') : (d.base ? `${d.base}${webhookHint(form.type)}?token=${d.ingestToken || ''}` : ''))
    }).catch(() => {})
    return () => { alive = false }
  }, [id, isNew, isAlarm, isAccess]) // eslint-disable-line react-hooks/exhaustive-deps
  const copyIngest = async () => {
    try { await navigator.clipboard.writeText(ingestUrl); toast('URL copiada') } catch { toast('No se pudo copiar', 'error') }
  }
  // Canales asociados a este NVR = dispositivos con la misma IP y un nº de canal.
  const nvrChannels = isNvr && form.ip
    ? allDevices.filter((x) => x.id !== id && x.ip === form.ip && x.channel != null && x.type !== 'nvr' && x.type !== 'alarm')
        .sort((a, b) => (Number(a.channel) || 0) - (Number(b.channel) || 0))
    : []
  // Guardrail contra error humano: si esta cámara/portero toma una IP que YA es de
  // un NVR existente, al guardar quedaría como un canal de ese NVR (ch1) sin querer.
  const ipTrim = String(form.ip || '').trim()
  const nvrAtIp = !isNvr && !isAlarm && ipTrim
    ? allDevices.find((x) => x.id !== id && String(x.ip || '').trim() === ipTrim && x.type === 'nvr')
    : null
  const chNow = form.channel === '' || form.channel == null ? null : Number(form.channel)
  const dupChannel = ipTrim && chNow != null
    ? allDevices.find((x) => x.id !== id && String(x.ip || '').trim() === ipTrim && Number(x.channel) === chNow && x.type !== 'nvr')
    : null
  useEffect(() => {
    if (isNew) return
    let alive = true
    collectionApi('devices').get(id)
      .then((d) => { if (alive) setForm({ ...EMPTY, ...d, type: normalizeDeviceType(d.type) }) })
      .catch((e) => toast(e.message || 'No se pudo cargar', 'error'))
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [id, isNew]) // eslint-disable-line react-hooks/exhaustive-deps

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))
  const onType = (e) => setForm((f) => ({ ...f, type: e.target.value }))
  const curMfr = MANUFACTURERS.find((m) => m.id === form.vendor) || null
  // Elegir fabricante ajusta vendor y puertos — NO el tipo (son campos independientes).
  const pickMfr = (m) => setForm((f) => ({ ...f, vendor: m.id, isapiPort: m.isapiPort ?? f.isapiPort, rtspPort: m.rtspPort ?? f.rtspPort }))
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
  // Alta paso a paso: Marca (0) → Tipo (1) → Conexión (2). Cámara/NVR exigen probar
  // la conexión; alarma/portero/acceso pasan directo a la ficha al elegir el tipo.
  const needsProbe = isCamera || isNvr
  const fichaReady = !isNew || (newStep >= 2 && (!needsProbe || probed))
  const gated = !fichaReady
  const onProbed = (r) => {
    setProbed(true)
    setForm((f) => ({
      ...f,
      vendor: f.vendor || r.device?.model || f.vendor,
      name: (f.name && f.name.trim()) ? f.name : (r.device?.name || f.name),
    }))
  }
  // Tarjeta de relés/puertas — reutilizable: va en el formulario (NVR/alarma sin
  // preview) o debajo del "Canal en vivo" en cámaras con vista previa.
  const renderRelays = (spanAll) => (
    <div className={`dev-card${spanAll ? ' span-all' : ''}`}>
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
  )
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

  // Contadores para los badges numéricos de cada pestaña. Los baratos salen del
  // form (relés, medios); logs/usuarios llegan async cuando su tab carga.
  const relayCount = Array.isArray(form.relays) ? form.relays.length : 0
  const mediosCount = isNvr ? nvrChannels.length : ['streamUrl', 'snapshotUrl', 'rtspUrl'].filter((k) => String(form[k] || '').trim()).length
  const alertsOnCount = (() => {
    const a = form.alerts
    if (!a || a.enabled === false) return null
    const t = a.types && typeof a.types === 'object' ? a.types : null
    if (!t) return null
    const on = Object.values(t).filter((v) => v !== false).length
    return on || null
  })()
  const TABS = [
    { k: 'datos', icon: 'device', label: 'Datos' },
    { k: 'reles', icon: isAlarm ? 'siren' : 'route', label: isAlarm ? 'Central y relés' : (isAccess || isIntercom ? 'Relés / Puertas' : 'Relés / Puertas'), hide: !hasRelays, badge: relayCount || null },
    { k: 'alertas', icon: 'bell', label: 'Alertas', badge: alertsOnCount },
    { k: 'medios', icon: 'video', label: isNvr ? 'Canales' : 'Medios de video', hide: isAlarm, badge: mediosCount || null },
    { k: 'salud', icon: 'gauge', label: 'Salud' },
    { k: 'logs', icon: 'rules', label: 'Logs', badge: tabCounts.logs },
    { k: 'usuarios', icon: 'operators', label: 'Usuarios', hide: !isIntercom, badge: tabCounts.usuarios, accent: true },
  ]

  const tabsEl = (
    <div className="subtabs dev-tabs">
      {TABS.filter((t) => !t.hide && (!gated || t.k === 'datos')).map((t) => (
        <button type="button" key={t.k} className={`subtab${tab === t.k ? ' is-on' : ''}${t.accent ? ' subtab--accent' : ''}`} onClick={() => setTab(t.k)}>
          <Icon name={t.icon} size={15} /> {t.label}
          {t.badge != null && t.badge !== '' && <span className="subtab__badge">{t.badge}</span>}
        </button>
      ))}
    </div>
  )

  return (
    <EditPage title={isNew ? 'Nuevo dispositivo' : 'Editar dispositivo'}
      subtitle="Cámara, NVR o central que genera eventos hacia EventOS." onCancel={back} onSave={save} saving={saving}
      saveDisabled={gated} saveLabel="Probá la conexión primero" tabs={tabsEl}>

      {/* ===== Pestaña DATOS ===== */}
      {tab === 'datos' && (
        <div key="datos" className={`dev-premium anim-rise ${!gated && hasAside ? 'dev-premium--aside' : ''}`}>
          <div className="dev-form">
            {gated && (
              <div className="wizx span-all">
                <div className="wizx__rail" style={{ '--prog': `${(newStep / 2) * 100}%` }}>
                  <span className="wizx__track"><span className="wizx__fill" /></span>
                  {WIZ_STEPS.map((s, i) => (
                    <button type="button" key={s.k} disabled={i > newStep}
                      className={`wiznode${newStep === i ? ' is-cur' : ''}${newStep > i ? ' is-done' : ''}`}
                      onClick={() => newStep > i && setNewStep(i)}>
                      <span className="wiznode__dot">
                        <span className="wiznode__ring" />
                        {newStep > i ? <Icon name="check" size={18} /> : <Icon name={s.icon} size={18} />}
                      </span>
                      <span className="wiznode__txt">
                        <span className="wiznode__n">Paso {i + 1}</span>
                        <span className="wiznode__lbl">{s.lbl}</span>
                      </span>
                    </button>
                  ))}
                </div>

                {newStep === 0 && (
                  <div className="wizx__body anim-rise">
                    <div className="wizx__head">
                      <h3 className="wizx__q">¿Qué marca es el equipo?</h3>
                      <p className="wizx__sub">Elegí el fabricante — preconfiguramos puertos y protocolo de descubrimiento.</p>
                    </div>
                    <div className="brandgrid2">
                      {MANUFACTURERS.map((m) => (
                        <button type="button" key={m.id} className={`brandtile${form.vendor === m.id ? ' is-on' : ''}`}
                          onClick={() => { pickMfr(m); setNewStep(1) }}>
                          <span className="brandtile__logo"><VendorLogo id={m.id} variant="tile" size={46} /></span>
                          <span className="brandtile__lbl">{m.label}</span>
                          {form.vendor === m.id && <span className="brandtile__check"><Icon name="check" size={13} /></span>}
                        </button>
                      ))}
                    </div>
                    {curMfr && <div className="mfr-hint"><Icon name="bell" size={14} /> <span>{curMfr.hint}</span></div>}
                  </div>
                )}

                {newStep === 1 && (
                  <div className="wizx__body anim-rise">
                    <div className="wizx__head">
                      <h3 className="wizx__q">¿Qué tipo de dispositivo es?</h3>
                      <p className="wizx__sub">Define qué campos y recursos aplican. <span className="wizx__ctx"><VendorLogo id={form.vendor} size={14} /></span></p>
                    </div>
                    <div className="typegrid3">
                      {DEVICE_TYPES.map((t) => (
                        <button type="button" key={t.value} className={`typetile${form.type === t.value ? ' is-on' : ''}`}
                          onClick={() => { setForm((f) => ({ ...f, type: t.value })); setNewStep(2) }}>
                          <span className="typetile__ic"><Icon name={DEVICE_TYPE_ICON[t.value] || 'device'} size={24} /></span>
                          <span className="typetile__body">
                            <span className="typetile__lbl">{deviceTypeLabel(t.value)}</span>
                            <span className="typetile__desc">{TYPE_DESC[t.value]}</span>
                          </span>
                          <span className="typetile__go"><Icon name="chevron" size={16} /></span>
                        </button>
                      ))}
                    </div>
                    <button type="button" className="wizx__back" onClick={() => setNewStep(0)}>← Cambiar marca</button>
                  </div>
                )}

                {newStep === 2 && needsProbe && (
                  <div className="wizx__body anim-rise">
                    <div className="wizx__head">
                      <h3 className="wizx__q">Conectá y escaneá el equipo</h3>
                      <p className="wizx__sub">Verificamos el acceso e importamos sus recursos automáticamente. <span className="wizx__ctx"><VendorLogo id={form.vendor} size={14} /> · {deviceTypeLabel(form.type)}</span></p>
                    </div>
                    <div className="wizx__conn">
                      <div className="wizx__connform">
                        <div className="dev-grid dev-grid--4">
                          <Field label={<><Icon name="globe" size={14} /> IP</>} className="span-2">
                            <TextInput autoFocus value={form.ip} onChange={set('ip')} placeholder="192.168.99.96" />
                          </Field>
                          <Field label={<><Icon name="hash" size={14} /> Puerto ISAPI/HTTP</>} hint="80 por defecto.">
                            <TextInput type="number" value={form.isapiPort ?? ''} onChange={set('isapiPort')} placeholder="80" />
                          </Field>
                          <Field label={<><Icon name="hash" size={14} /> Puerto RTSP</>} hint="554 por defecto.">
                            <TextInput type="number" value={form.rtspPort ?? ''} onChange={set('rtspPort')} placeholder="554" />
                          </Field>
                          <Field label={<><Icon name="user" size={14} /> Usuario</>} className="span-2">
                            <TextInput value={form.username || ''} onChange={set('username')} placeholder="admin" autoComplete="off" />
                          </Field>
                          <Field label={<><Icon name="shield" size={14} /> Contraseña</>} className="span-2">
                            <TextInput type="password" value={form.password || ''} onChange={set('password')} placeholder="••••••••" autoComplete="new-password" />
                          </Field>
                        </div>
                        <button type="button" className="wizx__back" onClick={() => setNewStep(1)}>← Cambiar tipo</button>
                      </div>

                      <aside className="scanpanel">
                        <div className={`scanviz${canProbe ? ' is-ready' : ''}`}>
                          <span className="scanviz__pulse" />
                          <span className="scanviz__pulse scanviz__pulse--2" />
                          <span className="scanviz__core"><Icon name={DEVICE_TYPE_ICON[form.type] || 'device'} size={26} /></span>
                          <span className="scanviz__sweep" />
                        </div>
                        <div className="scanpanel__txt">
                          <b>Escaneo de recursos</b>
                          <p>{canProbe
                            ? `Al escanear traemos canales, analíticas, relés y streams del ${isNvr ? 'NVR' : 'equipo'} — listos para importar.`
                            : 'Completá IP y usuario para habilitar el escaneo.'}</p>
                        </div>
                        <div className="scanpanel__tags">
                          {(isNvr ? ['Canales', 'Analíticas', 'Relés', 'Streams'] : ['Video', 'Analíticas', 'Relés', 'Snapshot']).map((t) => (
                            <span key={t} className="scanpanel__tag"><Icon name="check" size={11} /> {t}</span>
                          ))}
                        </div>
                        <Button variant="primary" icon="search" disabled={!canProbe} onClick={() => setProbing(true)}>Escanear e importar recursos</Button>
                      </aside>
                    </div>
                  </div>
                )}
              </div>
            )}

            {!gated && (<>
            {isNew && !isAlarm && (
              <div className="dev-card dev-cta span-all">
                <div className="dev-cta__body">
                  <span className="dev-chip t-group"><Icon name="check" size={17} /></span>
                  <div className="dev-cta__txt">
                    <b>Conexión verificada</b>
                    <p>El equipo respondió. Completá la ficha y guardá. Podés volver a probar o importar recursos cuando quieras.</p>
                  </div>
                </div>
                <Button variant="secondary" icon="search" disabled={!canProbe} onClick={() => setProbing(true)}>Volver a probar</Button>
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
                  <Select value={form.vendor || ''} onChange={set('vendor')}>
                    <option value="">— Elegir —</option>
                    {VENDORS.map((v) => <option key={v} value={v}>{v}</option>)}
                    {form.vendor && !VENDORS.includes(form.vendor) && <option value={form.vendor}>{form.vendor}</option>}
                  </Select>
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
              {nvrAtIp && (
                <div className="dev-notice dev-notice--warn">
                  <Icon name="alert" size={17} />
                  <div className="dev-notice__body">
                    <b>Esta IP ya es del NVR «{nvrAtIp.name}».</b>
                    <p>Guardado así, {isIntercom ? 'este portero' : 'esta cámara'} queda como el <b>canal #{chNow ?? 1}</b> de ese NVR. Si es una cámara del grabador, elegí bien el <b>Canal</b> arriba; si es un equipo <b>independiente</b>, poné su propia IP. Para dar de alta las cámaras del NVR de una, abrí el NVR «{nvrAtIp.name}» y usá <b>«Descubrir cámaras del NVR»</b>.</p>
                    {dupChannel && <p className="dev-notice__dup"><Icon name="alert" size={13} /> El canal #{chNow} de esta IP ya existe: «{dupChannel.name}» — lo estarías duplicando.</p>}
                  </div>
                </div>
              )}
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
              <Field label={<><Icon name="shield" size={14} /> Ubicación en el muro</>} className="u-mt-12"
                hint="En la verificación en vivo agrupa las cámaras: «Interior» a la izquierda del Hero, «Perímetro» a la derecha.">
                <Select value={form.area || ''} onChange={set('area')}>
                  <option value="">— Sin clasificar —</option>
                  <option value="interior">Interior</option>
                  <option value="perimeter">Perímetro</option>
                </Select>
              </Field>
              <div className="dev-grid dev-grid--2 u-mt-12">
                <Field label={<><Icon name="video" size={14} /> Fuente de video (vivo)</>}
                  hint="Auto: prueba la IP directa y cae al NVR si no la alcanza. Directo: siempre por la IP de la cámara. Por NVR: siempre por el restream del NVR (IP alcanzable + canal).">
                  <Select value={form.liveSource || 'auto'} onChange={set('liveSource')}>
                    <option value="auto">Auto (recomendado)</option>
                    <option value="direct">Directo a la cámara</option>
                    <option value="nvr">Por el NVR</option>
                  </Select>
                </Field>
                <Field label={<><Icon name="play" size={14} /> Fuente de grabaciones</>}
                  hint="Por NVR: las grabaciones se leen del NVR (lo normal). SD de la cámara: para cámaras con grabación local (edge).">
                  <Select value={form.playbackSource || 'nvr'} onChange={set('playbackSource')}>
                    <option value="nvr">Por el NVR</option>
                    <option value="direct">SD de la cámara</option>
                  </Select>
                </Field>
                <Field label={<><Icon name="gauge" size={14} /> Procesamiento del vivo</>}
                  hint="Hardware GPU (VAAPI): transcodifica por la iGPU → CPU ~0 y escala a muchos canales (requiere GPU en el server). Copy: reenvía el H264 sin re-encodar, el más ligero, si la cámara se ve bien. Transcode CPU: libx264, compatible con todo — úsalo en fisheye/H.264+ que se ven rotas.">
                  <Select value={form.videoMode || 'transcode'} onChange={set('videoMode')}>
                    <option value="transcode">Transcode CPU (compatible)</option>
                    <option value="hw">Hardware GPU · VAAPI (recomendado)</option>
                    <option value="copy">Copy (sin transcode · el más ligero)</option>
                  </Select>
                </Field>
              </div>
            </div>

            {(isAlarm || isAccess) && !isNew && (
              <div className="dev-card span-all">
                <div className="webhook-row">
                  <span className="dev-chip t-cred"><Icon name="link" size={16} /></span>
                  <div className="dev-sec__t">
                    <span className="dev-sec__title">Webhook de eventos
                      <InfoHint side="right" content={<>URL a la que el equipo hace <b>POST</b> de sus eventos (ya incluye el token de ingesta). Pegala en la config de red del equipo.<span className="tt__eg">{ingestUrl || 'Cargando…'}</span></>} /></span>
                    <span className="dev-sec__sub">Punto de recepción HTTP de esta central. Detalle en <b>Configuración › Endpoints de ingesta</b>.</span>
                  </div>
                  <button type="button" className="iconbtn" onClick={copyIngest} title={ingestUrl ? 'Copiar URL' : 'Cargando…'} disabled={!ingestUrl} aria-label="Copiar URL del webhook">
                    <Icon name="copy" size={16} />
                  </button>
                </div>
              </div>
            )}
            </>)}
          </div>

          {/* Aside derecho: video (cámara) o ficha contextual (alarma / NVR) */}
          {!gated && canPreview && (
            <aside className="dev-aside">
              {/* Bloque de tamaño FIJO (16:9). El video LLENA el bloque (object-fit
                  cover) → nunca re-dimensiona. Los controles (título/editar/sync/relés)
                  y los nombres de analíticas están OCULTOS y aparecen al pasar el mouse. */}
              <div className="livecard">
                <Go2RtcView key={liveQuality} deviceId={id} quality={liveQuality} rules={ana && ana.rules} space={ana && ana.space}
                  onAspect={() => setVideoReady(true)} onPoster={() => setVideoReady(true)} />
                {ana && ana.rules && ana.rules.length > 0 && <AnalyticsLabels rules={ana.rules} space={ana.space} />}
                {!videoReady && <div className="livecard__skel" aria-hidden="true" />}
                <div className="livecard__top">
                  <span className="livecard__chip livecard__title"><Icon name="video" size={13} /> Canal en vivo <b>· #{form.channel ?? '—'}</b></span>
                  <span className="livecard__topr">
                    <span className="livecard__seg" role="group" aria-label="Flujo de video">
                      <button type="button" className={`livecard__segbtn${liveQuality === 'sub' ? ' is-on' : ''}`}
                              onClick={() => { if (liveQuality !== 'sub') { setVideoReady(false); setLiveQuality('sub') } }}
                              title="Flujo secundario (más liviano, arranca más rápido)">Sub</button>
                      <button type="button" className={`livecard__segbtn${liveQuality === 'main' ? ' is-on' : ''}`}
                              onClick={() => { if (liveQuality !== 'main') { setVideoReady(false); setLiveQuality('main') } }}
                              title="Flujo principal (máxima calidad)">Principal</button>
                    </span>
                    <button type="button" className="livecard__chip" onClick={() => setEditingAna(true)}
                            title="Dibujar / editar las analíticas en la cámara"><Icon name="edit" size={13} /> Editar</button>
                    <button type="button" className="livecard__chip" onClick={() => refreshCameraAnalytics(id)}
                            title="Volver a leer las analíticas del equipo"><Icon name="refresh" size={13} /> Sincronizar</button>
                  </span>
                </div>
                {(form.relays || []).length > 0 && (
                  <div className="livecard__relays">
                    {(form.relays || []).map((r, i) => (
                      <button type="button" key={i} className="livecard__relay" disabled={isNew}
                              onClick={() => triggerRelay(r)} title={`Abrir ${r.name || 'relé'} (acción física, pide confirmación)`}>
                        <Icon name="route" size={13} /> {r.name || `Salida ${r.output ?? i + 1}`}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <DeviceCaptures deviceId={id} />
            </aside>
          )}
          {!gated && !canPreview && isNvr && !isNew && (
            <aside className="dev-aside">
              <div className="dev-aside__hd"><span className="dev-chip t-media"><Icon name="device" size={16} /></span>
                <div className="dev-sec__t"><span className="dev-sec__title">Cámaras del NVR</span>
                  <span className="dev-sec__sub">{nvrChannels.length ? `${nvrChannels.length} canal(es) asociado(s)` : 'Sin canales cargados aún'}</span></div>
              </div>
              <Button variant="primary" icon="search" className="u-full u-mt-8" disabled={!canProbe} onClick={() => setProbing(true)}
                title={canProbe ? 'Escanea el NVR e importa sus cámaras' : 'Completá IP y usuario del NVR'}>
                Descubrir cámaras del NVR
              </Button>
              {nvrChannels.length > 0 ? (
                <div className="nvrgrid">
                  {nvrChannels.map((c) => (
                    <button type="button" key={c.id} className="nvrch" onClick={() => navigate(`/admin/devices/${c.id}`)} title={c.name}>
                      <span className="nvrch__thumb">
                        <img src={`/api/camera/${c.id}/snapshot`} alt="" onError={(e) => { e.currentTarget.style.opacity = 0 }} />
                        <span className="nvrch__ch">CH {c.channel}</span>
                        <span className={`nvrch__dot${c.enabled === false ? ' is-off' : ''}`} />
                      </span>
                      <span className="nvrch__name">{c.name}</span>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="dev-sidecard__txt">Las alertas se configuran <b>por cámara</b>, no en el NVR. Usá <b>«Descubrir cámaras del NVR»</b> (arriba) para crear un dispositivo por canal — se asocian a este NVR y a su sitio, y aparecen acá.</p>
              )}
              <p className="help-block u-mt-8">Tocá una cámara para abrir su ficha. Estado en vivo en <b>Salud</b>.</p>
            </aside>
          )}
        </div>
      )}

      {probing && <DeviceProbe device={form} onClose={() => setProbing(false)} onImport={applyImport} onProbed={onProbed} onCreated={reloadDevices} toast={toast} />}
      {editingAna && <AnalyticsEditor deviceId={id} onClose={() => setEditingAna(false)} onSaved={() => refreshCameraAnalytics(id)} />}

      {/* ===== Pestaña RELÉS / PUERTAS ===== */}
      {tab === 'reles' && hasRelays && (
        <div key="reles" className="dev-tabpane anim-rise">
          {isAlarm ? (
            <>
              <p className="section-label"><Icon name="siren" size={14} /> Central de alarma
                <InfoHint side="right" content={<>Armado/desarmado, pánico, salidas de relé y actividad reciente de la central. Con paneles Hik AX podés operar sus salidas y enterarte de puertas abiertas / aperturas remotas.</>} /></p>
              <p className="help-block">Armado, pánico, relés y últimos eventos de la central.</p>
              <AlarmPanel device={form} id={id} isNew={isNew} armed={form.armed} onArmed={(v) => setForm((f) => ({ ...f, armed: v }))} toast={toast} />
            </>
          ) : (
            <>
              <p className="section-label"><Icon name="route" size={14} /> Relés y puertas
                <InfoHint side="right" content={<>Salidas físicas del equipo para abrir puertas o accionar dispositivos. El operador puede accionarlas desde la consola durante un evento.<span className="tt__eg">Ej.: «Portón principal» → salida 1.</span></>} /></p>
              <p className="help-block">Salidas de relé de este equipo. Definí nombre y nº de salida; «Abrir» acciona el relé físico y pide confirmación.</p>
              {renderRelays(true)}
            </>
          )}
        </div>
      )}

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
            <div className={isIntercom && !isNew ? 'dev-alerts2' : undefined}>
              <div>
              <p className="section-label"><Icon name="bell" size={14} /> Alertas — cómo alerta este dispositivo
                <InfoHint side="right" content={<>Definí qué eventos de este equipo interrumpen al operador, con qué prioridad, con qué filtro de objetivo y en qué horario. Lo que apagues queda solo en analítica (no molesta). Probá que llega bien con «Probar alerta».<span className="tt__eg">Ej.: solo «Cruce de línea» + «Intrusión», solo personas, de noche.</span></>} /></p>
              <p className="help-block">Qué eventos disparan alerta, con qué prioridad, filtro por objetivo y en qué horario. Probá que llega bien a la consola con «Probar alerta».</p>
              <AlertsConfig deviceType={form.type} alerts={form.alerts}
                onChange={(alerts) => setForm((f) => ({ ...f, alerts }))}
                deviceId={id} isNew={isNew} toast={toast} split={!isIntercom} />
              </div>
              {isIntercom && !isNew && (
                <div className="dev-alerts2__side">
                  <div className="accbadge-cfg">
                    <p className="section-label"><Icon name="user" size={14} /> Badge de acceso en vivo
                      <InfoHint side="right" content={<>Cuando alguien entra por este portero (tarjeta / PIN / rostro / QR válido), mostrar un aviso efímero con su nombre sobre el video en vivo (popup y videowall). La lectura <b>siempre se registra</b> para auditoría; este toggle sólo controla el aviso visual.<span className="tt__eg">«Heredar del cliente» usa el valor del sitio; por defecto está activo.</span></>} /></p>
                    <p className="help-block">Aviso efímero con el nombre de quien entra, sobre el vivo. No afecta el registro/auditoría.</p>
                    <Segmented
                      value={form.accessBadge === true ? 'on' : form.accessBadge === false ? 'off' : 'inherit'}
                      onChange={(v) => setForm((f) => ({ ...f, accessBadge: v === 'on' ? true : v === 'off' ? false : null }))}
                      options={[{ value: 'inherit', label: 'Heredar del cliente' }, { value: 'on', label: 'Mostrar' }, { value: 'off', label: 'Ocultar' }]} />
                  </div>
                  <AkuvoxActionUrls deviceId={id} />
                </div>
              )}
            </div>
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

      {/* ===== Pestaña LOGS ===== */}
      {tab === 'logs' && (
        <div key="logs" className="dev-tabpane anim-rise">
          <p className="section-label"><Icon name="rules" size={14} /> Logs — registro del dispositivo
            <InfoHint side="right" content={<>Linea de tiempo del equipo: en porteros Akuvox, las aperturas (tarjeta/PIN/rostro/QR) y llamadas leidas por su HTTP API; en todos, los eventos de EventOS de este dispositivo, fusionados en una sola vista.</>} /></p>
          <p className="help-block">Movimientos del equipo (aperturas, llamadas) fusionados con los eventos de EventOS de este dispositivo.</p>
          <DeviceLogs device={form} isNew={isNew} onCount={(n) => setTabCounts((c) => (c.logs === n ? c : { ...c, logs: n }))} />
        </div>
      )}

      {/* ===== Pestaña USUARIOS (portero Akuvox) ===== */}
      {tab === 'usuarios' && isIntercom && (
        <div key="usuarios" className="dev-tabpane anim-rise">
          <p className="section-label"><Icon name="operators" size={14} /> Usuarios cargados en el portero
            <InfoHint side="right" content={<>Todo lo que el portero tiene dentro por persona: nombre, tarjeta RFID, PIN privado y rostro. Se lee directo del equipo por su HTTP API (user/get). Los rostros se muestran vía proxy del server.</>} /></p>
          <p className="help-block">Nombre, tarjeta, PIN y rostro de cada usuario, leídos directo del equipo. Buscá, paginá y revelá los PIN cuando lo necesites.</p>
          <AkuvoxUsers deviceId={id} isNew={isNew} onCount={(n) => setTabCounts((c) => (c.usuarios === n ? c : { ...c, usuarios: n }))} />
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
      {/* AkuvoxActionUrls vive ahora en la pestana Alertas (columna derecha) */}
    </EditPage>
  )
}
