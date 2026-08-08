// DeviceWizard — asistente paso a paso para dar de alta un dispositivo:
// 1) Tipo + nombre  2) Conexión  3) Ubicación  4) Revisar y crear.
// Al crear, redirige a la edición para afinar alertas/video.
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Field, TextInput, Select, Combobox, Icon } from '../ui/primitives.jsx'
import { collectionApi, unwrap, DEVICE_TYPES } from '../lib/adminApi.js'
import { deviceTypeLabel, priorityLabel, DEVICE_TYPE_ICON } from '../lib/labels.js'
import { PageHead, useToast } from './_shared.jsx'
import { Wizard } from './Wizard.jsx'

const STEPS = [
  { key: 'type', label: 'Tipo y nombre', icon: 'device' },
  { key: 'conn', label: 'Conexión', icon: 'link' },
  { key: 'place', label: 'Ubicación', icon: 'site' },
  { key: 'review', label: 'Revisar', icon: 'check' },
]
const VENDORS = ['Hikvision', 'Dahua', 'Tiandy', 'Akuvox', 'Uniview', 'Otro']
// Descripción corta por CATEGORÍA — llena mejor la tarjeta y orienta al usuario.
const TYPE_DESC = {
  camera: 'Cámara IP · RTSP + eventos (ISAPI / ONVIF).',
  nvr: 'Grabador con varias cámaras · RTSP por canal.',
  alarm: 'Central de alarma · reporta por IP/HTTP, sin video.',
  intercom: 'Portero / intercom IP · video, audio y relé.',
  access: 'Control de acceso · puertas / relés y eventos.',
}

// Columna explicativa (derecha) — qué hace cada paso y qué pasa según lo elegido.
function stepHelp(step, f, isCam) {
  if (step === 0) return {
    icon: 'device', title: 'Tipo y nombre',
    lead: 'Definí qué es el equipo y cómo se llama dentro de EventOS.',
    points: [
      'El tipo determina qué campos y recursos aplican: una cámara/NVR trae video y analíticas; una alarma reporta sin video; un portero suma audio y relé.',
      'El fabricante preconfigura los puertos y el protocolo de descubrimiento (Hikvision→ISAPI, Tiandy→RTSP, resto→ONVIF).',
      'El nombre es cómo lo verás en la consola y los eventos.',
    ],
  }
  if (step === 1) return isCam ? {
    icon: 'globe', title: 'Conexión',
    lead: 'Con estos datos EventOS arma el RTSP/snapshot y descubre los canales del equipo.',
    points: [
      'IP + usuario/clave: se usan para probar el equipo e importar sus canales y relés. Nunca viajan en la URL.',
      'Puertos: 80 (ISAPI/HTTP) y 554 (RTSP) por defecto — cambialos solo si tu equipo usa otros.',
      'IP directa (opcional): si la cámara está detrás de un NVR pero la alcanzás por su IP (VPN), el vivo sale directo, con menos latencia.',
    ],
  } : {
    icon: 'siren', title: 'Conexión',
    lead: 'Las centrales de alarma reportan por webhook — no necesitan IP de cámara.',
    points: [
      'Tras crearla, la URL exacta (con token) para configurar el equipo aparece en Configuración › Endpoints de ingesta.',
      'El equipo se identifica por su IP/payload al hacer POST de sus eventos.',
    ],
  }
  if (step === 2) return {
    icon: 'site', title: 'Ubicación y prioridad',
    lead: 'Agrupá el equipo por cliente y definí su urgencia base.',
    points: [
      'El sitio agrupa por cliente y afecta el despacho (afinidad por sitio), los informes y los filtros.',
      'La prioridad por defecto ordena la cola cuando ninguna regla dice otra cosa (1 = crítica … 5 = baja).',
      'La zona es una etiqueta libre de ubicación (p. ej. «Acceso Norte»).',
    ],
  }
  return {
    icon: 'check', title: 'Revisar y crear',
    lead: 'Confirmá el resumen. Todo es editable después.',
    points: [
      'Al crear, vas directo a la ficha del equipo para afinar alertas, medios de video y relés.',
      'Podés volver a cualquier paso desde el riel superior.',
    ],
  }
}

export default function DeviceWizard() {
  const navigate = useNavigate()
  const toast = useToast()
  const [step, setStep] = useState(0)
  const [sites, setSites] = useState([])
  const [creating, setCreating] = useState(false)
  const [f, setF] = useState({
    name: '', type: 'camera', vendor: '', ip: '', channel: 1,
    username: 'admin', password: '', isapiPort: 80, rtspPort: 554, camIp: '',
    siteId: '', zone: '', defaultPriority: null, enabled: true,
  })
  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }))

  useEffect(() => { collectionApi('sites').list().then((d) => setSites(unwrap(d, 'sites'))).catch(() => {}) }, [])

  const isCam = f.type === 'camera' || f.type === 'nvr' || f.type === 'intercom'
  const canNext =
    step === 0 ? !!f.name.trim() :
    step === 1 ? (!isCam || !!f.ip.trim()) : true

  const createSite = async (name) => {
    const nm = (name || '').trim(); if (!nm) return null
    try { const c = await collectionApi('sites').create({ name: nm }); if (c?.id) { setSites((p) => [...p, c]); toast(`Sitio «${nm}» creado`); return c.id } } catch (e) { toast(e.message, 'error') }
    return null
  }

  const finish = async () => {
    setCreating(true)
    const payload = {
      ...f,
      vendor: f.vendor || '',
      channel: f.channel === '' ? null : Number(f.channel),
      isapiPort: f.isapiPort ? Number(f.isapiPort) : null,
      rtspPort: f.rtspPort ? Number(f.rtspPort) : null,
      camIp: (f.camIp || '').trim() || null,
      defaultPriority: f.defaultPriority ? Number(f.defaultPriority) : null,
      siteId: f.siteId || null,
    }
    try {
      const created = await collectionApi('devices').create(payload)
      toast('Dispositivo creado')
      navigate(created?.id ? `/admin/devices/${created.id}` : '/admin/devices')
    } catch (e) { toast(e.message || 'No se pudo crear', 'error'); setCreating(false) }
  }

  return (
    <div className="anim-rise">
      <PageHead title="Nuevo dispositivo — asistente" subtitle="Te guío paso a paso para conectarlo bien." />
      <div className="wizpage wizpage--full">
       <div className="wiz-2col">
        <Wizard steps={STEPS} step={step} onStep={setStep} onCancel={() => navigate('/admin/devices')}
          onFinish={finish} canNext={canNext} finishing={creating} finishLabel="Crear dispositivo">

          {step === 0 && (
            <>
              <p className="wiz__q">¿Qué tipo de equipo es?</p>
              <div className="etgrid wiz__typegrid">
                {DEVICE_TYPES.map((t) => (
                  <button type="button" key={t.value} className={`etcard${f.type === t.value ? ' is-on' : ''}`}
                    onClick={() => setF((p) => ({ ...p, type: t.value }))}>
                    <span className="etcard__ic"><Icon name={DEVICE_TYPE_ICON[t.value] || 'device'} size={22} /></span>
                    <span className="etcard__lbl">{deviceTypeLabel(t.value)}</span>
                    <span className="etcard__desc">{TYPE_DESC[t.value]}</span>
                    {f.type === t.value && <span className="etcard__check"><Icon name="check" size={13} /></span>}
                  </button>
                ))}
              </div>
              <div className="form-grid form-grid--2 u-mt-16">
                <Field label={<><Icon name="device" size={14} /> Nombre del dispositivo</>}>
                  <TextInput autoFocus value={f.name} onChange={set('name')} placeholder="Cámara Acceso Norte" />
                </Field>
                <Field label={<><Icon name="shield" size={14} /> Fabricante</>} hint="Marca del equipo (independiente del tipo).">
                  <Select value={f.vendor} onChange={set('vendor')}>
                    <option value="">— Elegir —</option>
                    {VENDORS.map((v) => <option key={v} value={v}>{v}</option>)}
                  </Select>
                </Field>
              </div>
            </>
          )}

          {step === 1 && (
            <>
              {isCam ? (
                <>
                  <p className="wiz__q">Datos de conexión</p>
                  <div className="form-grid form-grid--2">
                    <Field label={<><Icon name="globe" size={14} /> IP / host</>}>
                      <TextInput autoFocus value={f.ip} onChange={set('ip')} placeholder="192.168.1.64" />
                    </Field>
                    <Field label={<><Icon name="hash" size={14} /> Canal</>}>
                      <TextInput type="number" min="0" value={f.channel} onChange={set('channel')} placeholder="1" />
                    </Field>
                    <Field label={<><Icon name="user" size={14} /> Usuario</>}>
                      <TextInput value={f.username} onChange={set('username')} placeholder="admin" autoComplete="off" />
                    </Field>
                    <Field label={<><Icon name="shield" size={14} /> Contraseña</>}>
                      <TextInput type="password" value={f.password} onChange={set('password')} placeholder="••••••••" autoComplete="new-password" />
                    </Field>
                    <Field label={<><Icon name="hash" size={14} /> Puerto ISAPI/HTTP</>} hint="80 por defecto.">
                      <TextInput type="number" value={f.isapiPort} onChange={set('isapiPort')} placeholder="80" />
                    </Field>
                    <Field label={<><Icon name="hash" size={14} /> Puerto RTSP</>} hint="554 por defecto.">
                      <TextInput type="number" value={f.rtspPort} onChange={set('rtspPort')} placeholder="554" />
                    </Field>
                    <Field label={<><Icon name="globe" size={14} /> IP directa de cámara (opcional)</>} className="span-2"
                      hint="Si está detrás de un NVR pero la alcanzás por su IP (VPN), poné acá su IP para el vivo directo.">
                      <TextInput value={f.camIp} onChange={set('camIp')} placeholder="192.168.7.129" />
                    </Field>
                  </div>
                </>
              ) : (
                <div className="wiz__note">
                  <Icon name="siren" size={20} />
                  <p>Las centrales de alarma envían sus eventos por webhook (no necesitan IP de cámara). Después de crearla, la URL exacta para configurarla aparece en <b>Despacho → Recepción</b>.</p>
                </div>
              )}
            </>
          )}

          {step === 2 && (
            <>
              <p className="wiz__q">¿Dónde está y con qué prioridad?</p>
              <Field label={<><Icon name="building" size={14} /> Sitio / Cliente</>} hint="Agrupa el dispositivo por cliente. Escribí para buscar o crear uno.">
                <Combobox value={f.siteId || ''} onChange={(v) => setF((p) => ({ ...p, siteId: v }))}
                  options={[{ value: '', label: '— Sin sitio —' }, ...sites.map((s) => ({ value: s.id, label: s.name }))]}
                  placeholder="— Sin sitio —" searchPlaceholder="Buscar o crear sitio…" onCreate={createSite} createLabel="Crear sitio" />
              </Field>
              <div className="form-grid form-grid--2 u-mt-12">
                <Field label={<><Icon name="flag" size={14} /> Prioridad por defecto</>} hint="Opcional.">
                  <Select value={f.defaultPriority ?? ''} onChange={set('defaultPriority')}>
                    <option value="">— Catálogo —</option>
                    {[1, 2, 3, 4, 5].map((p) => <option key={p} value={p}>{`P${p} · ${priorityLabel(p)}`}</option>)}
                  </Select>
                </Field>
                <Field label={<><Icon name="pin" size={14} /> Zona</>} hint="Etiqueta de ubicación.">
                  <TextInput value={f.zone} onChange={set('zone')} placeholder="Acceso Norte" />
                </Field>
              </div>
            </>
          )}

          {step === 3 && (
            <>
              <p className="wiz__q">Revisá y creá</p>
              <div className="wiz__review">
                <Row k="Tipo" v={<><Icon name={DEVICE_TYPE_ICON[f.type] || 'device'} size={14} /> {deviceTypeLabel(f.type)}</>} />
                <Row k="Nombre" v={f.name || '—'} />
                {isCam && <Row k="IP / host" v={f.ip || '—'} />}
                {isCam && <Row k="Canal" v={f.channel ?? '—'} />}
                {isCam && <Row k="Usuario" v={f.username || '—'} />}
                {isCam && f.camIp && <Row k="IP directa" v={f.camIp} />}
                <Row k="Sitio" v={(sites.find((s) => s.id === f.siteId) || {}).name || '— Sin sitio —'} />
                <Row k="Prioridad" v={f.defaultPriority ? `P${f.defaultPriority}` : 'Catálogo'} />
                {f.zone && <Row k="Zona" v={f.zone} />}
              </div>
              <p className="help-block u-mt-12">Al crear, vas directo a la ficha del dispositivo para afinar <b>alertas</b> y <b>video</b>.</p>
            </>
          )}
        </Wizard>
        <aside className="wiz-help anim-rise" key={step}>
          {(() => { const h = stepHelp(step, f, isCam); return (<>
            <div className="wiz-help__hd"><span className="wiz-help__ic"><Icon name={h.icon} size={18} /></span>
              <div><span className="wiz-help__k">Paso {step + 1} de {STEPS.length}</span><b>{h.title}</b></div></div>
            <p className="wiz-help__lead">{h.lead}</p>
            <ul className="wiz-help__list">{h.points.map((p, i) => (
              <li key={i}><span className="wiz-help__b"><Icon name="check" size={12} /></span><span>{p}</span></li>
            ))}</ul>
          </>) })()}
        </aside>
       </div>
      </div>
    </div>
  )
}

function Row({ k, v }) {
  return <div className="wiz__rrow"><span className="wiz__rk">{k}</span><span className="wiz__rv">{v}</span></div>
}
