// Descubrir equipo (Hikvision ISAPI) — página dentro de Dispositivos.
// Sondea un NVR/cámara, lista canales/analíticas/streams y permite crear un
// dispositivo prellenado con los datos descubiertos.
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Panel, Button, Field, TextInput, Switch, Icon, Badge, Spinner, Segmented } from '../ui/primitives.jsx'
import { api } from '../lib/adminApi.js'
import { PageHead, useToast } from './_shared.jsx'

const EMPTY = { protocol: 'hikvision', host: '', port: '', user: 'admin', pass: '', https: false }
const PROTOCOLS = [
  { value: 'hikvision', label: 'Hikvision (ISAPI)' },
  { value: 'onvif', label: 'ONVIF (Perfil M)' },
]

export default function DeviceDiscover() {
  const toast = useToast()
  const navigate = useNavigate()
  const [form, setForm] = useState(EMPTY)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))

  const run = async () => {
    if (!form.host.trim()) { toast('Host / IP requerido', 'error'); return }
    setBusy(true); setResult(null)
    try {
      const r = await api.post('/discover', { ...form, port: form.port || undefined })
      setResult(r)
      const n = (r.channels || []).length
      toast(n ? `Equipo descubierto: ${n} canal(es)` : 'Conexión OK, sin canales detectados')
    } catch (e) { toast(e.message || 'No se pudo descubrir', 'error') }
    finally { setBusy(false) }
  }

  return (
    <div className="anim-rise">
      <PageHead title="Descubrir equipo" subtitle="Sondea un NVR o cámara Hikvision (ISAPI) y registra sus canales como dispositivos."
        actions={<Button variant="ghost" icon="chevron" onClick={() => navigate('/admin/devices')}>Volver a dispositivos</Button>} />

      <Panel title={<span className="ptitle"><Icon name="search" size={16} /> Conexión</span>}
        subtitle="Lista canales, analíticas configuradas y rutas RTSP del equipo.">
        <Field label={<><Icon name="sliders" size={14} /> Protocolo</>} hint="ISAPI para Hikvision; ONVIF (Perfil M) para otros fabricantes compatibles.">
          <Segmented value={form.protocol} onChange={(v) => setForm((f) => ({ ...f, protocol: v }))} options={PROTOCOLS} />
        </Field>
        <div className="form-grid form-grid--2 u-mt-12">
          <Field label={<><Icon name="globe" size={14} /> Host / IP</>}>
            <TextInput value={form.host} onChange={set('host')} placeholder="192.168.1.10" autoFocus />
          </Field>
          <Field label={<><Icon name="hash" size={14} /> Puerto</>} hint={form.protocol === 'onvif' ? 'Vacío = 80 (a veces 8000).' : 'Vacío = 80 (o 443 con HTTPS).'}>
            <TextInput value={form.port} onChange={set('port')} placeholder={form.protocol === 'onvif' ? '80' : '80'} className="tnum" />
          </Field>
          <Field label={<><Icon name="user" size={14} /> Usuario</>}>
            <TextInput value={form.user} onChange={set('user')} placeholder="admin" />
          </Field>
          <Field label={<><Icon name="shield" size={14} /> Contraseña</>}>
            <TextInput type="password" value={form.pass} onChange={set('pass')} placeholder="••••••••" />
          </Field>
          <Field label={<><Icon name="link" size={14} /> HTTPS</>}>
            <Switch checked={form.https} onChange={(v) => setForm((f) => ({ ...f, https: v }))} label={form.https ? 'Sí' : 'No'} />
          </Field>
        </div>
        <Button variant="primary" icon={busy ? undefined : 'search'} disabled={busy} onClick={run} className="u-mt-12">
          {busy ? <Spinner size={15} /> : 'Descubrir equipo'}
        </Button>

        {result && <DiscoverResult result={result} conn={form} navigate={navigate} />}
      </Panel>
    </div>
  )
}

function DiscoverResult({ result, conn, navigate }) {
  const d = result.device
  // Construye una ruta RTSP por defecto si el descubrimiento devolvió una.
  const streamFor = (chId) => (result.streams || []).find((s) => String(s.id) === String(chId))

  const isOnvif = conn.protocol === 'onvif'
  const createDevice = (ch) => {
    const stream = streamFor(ch.id)
    navigate('/admin/devices/new', {
      state: {
        prefill: {
          name: ch.name || `${d?.name || 'Cámara'} ${ch.id}`,
          type: isOnvif ? 'generic' : 'hikvision',
          vendor: isOnvif ? (d?.model || '') : 'Hikvision',
          ip: ch.ip || conn.host, channel: isOnvif ? 1 : (ch.id || 1),
          rtspUrl: stream?.rtsp || '',
        },
      },
    })
  }

  return (
    <div className="discover u-mt-16">
      {d && (
        <div className="discover__dev">
          <span className="discover__dev-ic"><Icon name="device" size={20} /></span>
          <div className="discover__dev-info">
            <b>{d.name || 'Equipo'}</b>
            <span>{[d.model, d.deviceType, d.firmware].filter(Boolean).join(' · ') || '—'}</span>
            {d.serial && <span className="muted">S/N {d.serial}{d.mac ? ` · ${d.mac}` : ''}</span>}
          </div>
        </div>
      )}

      {result.channels?.length > 0 && (
        <>
          <p className="section-label"><Icon name="camera" size={14} /> Canales ({result.channels.length})</p>
          <div className="adm-table-wrap">
            <table className="adm-table">
              <thead><tr><th>#</th><th>Nombre</th><th>IP</th><th>Estado</th><th /></tr></thead>
              <tbody>
                {result.channels.map((c, i) => (
                  <tr key={c.id || i}>
                    <td className="cell-mono">{c.id || '—'}</td>
                    <td className="cell-name">{c.name || '—'}</td>
                    <td className="cell-mono">{c.ip || '—'}</td>
                    <td>{c.online ? <Badge tone="ok">En línea</Badge> : <span className="muted">—</span>}</td>
                    <td className="cell-actions">
                      <Button variant="ghost" size="sm" icon="plus" onClick={() => createDevice(c)}>Crear</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {result.analytics?.length > 0 && (
        <>
          <p className="section-label u-mt-16"><Icon name="filter" size={14} /> Analíticas configuradas ({result.analytics.length})</p>
          <div className="inline-tags">
            {result.analytics.map((a, i) => (
              <Badge key={i} tone="accent">{a.label}{a.channel ? ` · ch ${a.channel}` : ''}</Badge>
            ))}
          </div>
        </>
      )}

      {result.streams?.length > 0 && (
        <>
          <p className="section-label u-mt-16"><Icon name="video" size={14} /> Streams ({result.streams.length})</p>
          <div className="endpoint-list">
            {result.streams.map((s, i) => (
              <div className="endpoint" key={s.id || i}>
                <Icon name="video" size={16} />
                <div className="endpoint__meta">
                  <div className="endpoint__name">Canal {s.id} {s.codec && <Badge tone="neutral">{s.codec}</Badge>} {s.resolution && <span className="muted">{s.resolution}</span>}</div>
                  <div className="endpoint__url">{s.rtsp}</div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {result.errors?.length > 0 && (
        <p className="help-block u-mt-12" style={{ color: 'var(--warn)' }}>
          Avisos: {result.errors.join(' · ')}
        </p>
      )}
    </div>
  )
}
