// Recepción — cómo cada dispositivo envía sus eventos a EventOS:
// token de ingesta + URL EXACTA (lista para pegar) por dispositivo + guías por tipo.
import { useEffect, useMemo, useState } from 'react'
import { Panel, Icon, Badge, TextInput } from '../ui/primitives.jsx'
import { getReception } from '../lib/adminApi.js'
import { deviceTypeLabel, DEVICE_TYPE_ICON } from '../lib/labels.js'
import { PageHead, Loading, ErrorState, EmptyState, SectionHelp, useToast } from './_shared.jsx'

async function copyText(text, toast) {
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text)
    else {
      const ta = document.createElement('textarea')
      ta.value = text; document.body.appendChild(ta); ta.select()
      document.execCommand('copy'); document.body.removeChild(ta)
    }
    toast('Copiado al portapapeles')
  } catch { toast('No se pudo copiar', 'error') }
}

// Campo de URL/código copiable (la pieza central: clara y de un clic).
function CopyField({ value, mono = true }) {
  const toast = useToast()
  return (
    <button type="button" className={`copyfield${mono ? ' copyfield--mono' : ''}`} onClick={() => copyText(value, toast)} title="Copiar">
      <span className="copyfield__val">{value}</span>
      <span className="copyfield__ic"><Icon name="copy" size={15} /></span>
    </button>
  )
}

// Cómo apuntar cada tipo de dispositivo a EventOS (breve, accionable).
const GUIDES = {
  hikvision: { icon: 'camera', label: 'Cámara Hikvision', steps: 'En la cámara/NVR: Configuración → Red → Notificación de alarma (Alarm Server / HTTP Listening) → pegá la URL. O usá el alertStream ISAPI (ya conectado para Cesimco).' },
  nvr: { icon: 'device', label: 'NVR / DVR', steps: 'En el grabador: Configuración → Red → Plataforma / Centro de notificación → pegá la URL del endpoint NVR.' },
  akuvox: { icon: 'bell', label: 'Portero Akuvox', steps: 'En el portero: Ajustes → Acción / HTTP URL → pegá la URL en el evento de llamada o de puerta.' },
  alarm: { icon: 'siren', label: 'Central de alarma', steps: 'En la central / receptor: configurá el reporte por IP (HTTP) hacia la URL del endpoint de alarma.' },
  generic: { icon: 'globe', label: 'Genérico', steps: 'Enviá un POST con JSON del evento a la URL del endpoint genérico.' },
}

export default function Reception() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [q, setQ] = useState('')
  const toast = useToast()

  const load = () => {
    setLoading(true); setError(null)
    getReception().then((d) => setData(d)).catch(setError).finally(() => setLoading(false))
  }
  useEffect(load, [])

  const devices = useMemo(() => (data?.devices || []), [data])
  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase()
    if (!t) return devices
    return devices.filter((d) => `${d.name} ${deviceTypeLabel(d.type)}`.toLowerCase().includes(t))
  }, [devices, q])

  // Tipos presentes (para mostrar solo las guías relevantes).
  const presentTypes = useMemo(() => [...new Set(devices.map((d) => (GUIDES[d.type] ? d.type : 'generic')))], [devices])

  if (loading) return <><PageHead title="Recepción" /><Loading /></>
  if (error) return <><PageHead title="Recepción" /><ErrorState error={error} onRetry={load} /></>

  const token = data?.ingestToken
  const base = data?.base

  return (
    <div className="anim-rise recep">
      <PageHead title="Recepción" subtitle="Cómo cada dispositivo envía sus eventos a EventOS." />

      <SectionHelp id="reception" icon="link" title="Conectar un dispositivo a EventOS">
        Cada dispositivo manda sus eventos a una URL (webhook) que incluye el token de ingesta. Copiá la URL del equipo que querés conectar y pegala en su configuración de red. Abajo tenés la URL exacta lista para pegar por dispositivo.
      </SectionHelp>

      {/* Token de ingesta — prominente */}
      <div className="recep-token-card">
        <div className="recep-token-card__head">
          <span className="recep-token-card__ic"><Icon name="shield" size={18} /></span>
          <div>
            <p className="recep-token-card__title">Token de ingesta</p>
            <p className="recep-token-card__sub">Va en todas las URLs. No lo compartas fuera de la red del cliente.</p>
          </div>
        </div>
        {token
          ? <CopyField value={token} />
          : <EmptyState icon="reception" title="Sin token (modo abierto)">La ingesta no exige token (solo dev).</EmptyState>}
      </div>

      {/* Guías de conexión por tipo presente */}
      {presentTypes.length > 0 && (
        <div className="recep-guides">
          {presentTypes.map((t) => {
            const g = GUIDES[t] || GUIDES.generic
            return (
              <div className="recep-guide" key={t}>
                <span className="recep-guide__ic"><Icon name={g.icon} size={18} /></span>
                <div className="recep-guide__body">
                  <p className="recep-guide__label">{g.label}</p>
                  <p className="recep-guide__steps">{g.steps}</p>
                  {base && <CopyField value={`${base}/api/ingest/${t}?token=${token || ''}`} />}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Webhook por dispositivo */}
      <Panel title={<span className="ptitle"><Icon name="device" size={16} /> URL por dispositivo</span>}
        subtitle="La dirección exacta a pegar en cada equipo (incluye el token)."
        actions={devices.length > 6 ? (
          <div className="admin-search recep-search">
            <Icon name="search" size={15} />
            <TextInput placeholder="Buscar dispositivo…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
        ) : null}>
        {devices.length === 0
          ? <EmptyState icon="device" title="Sin dispositivos">Registrá dispositivos para ver su URL de ingesta.</EmptyState>
          : filtered.length === 0
            ? <EmptyState icon="search" title="Sin resultados" />
            : (
              <div className="recep-devs">
                {filtered.map((d) => (
                  <div className={`recep-dev${d.enabled === false ? ' is-off' : ''}`} key={d.id}>
                    <span className="recep-dev__ic"><Icon name={DEVICE_TYPE_ICON[d.type] || 'device'} size={18} /></span>
                    <div className="recep-dev__id">
                      <span className="recep-dev__name">{d.name}</span>
                      <span className="recep-dev__tags">
                        <Badge tone="accent">{deviceTypeLabel(d.type)}</Badge>
                        {d.enabled === false && <Badge tone="neutral">Deshabilitado</Badge>}
                      </span>
                    </div>
                    <CopyField value={d.urlWithToken || d.url} />
                  </div>
                ))}
              </div>
            )}
      </Panel>
    </div>
  )
}
