// Descubrir equipo — dos modos:
//   · "Escanear rango": barre un rango de IPs (WS-Discovery + TCP + ISAPI) y lista
//     todo lo que encuentra con marca/modelo/MAC/tipo y ESTADO (autenticado o no).
//     Cada equipo tiene "Agregar" que abre el asistente con los datos precargados.
//   · "Sondear un equipo": sondea un NVR/cámara puntual y lista sus canales.
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
const MODES = [
  { value: 'scan', label: 'Escanear rango' },
  { value: 'probe', label: 'Sondear un equipo' },
]
const TYPE_ICON = { nvr: 'device', camera: 'camera', intercom: 'speaker', alarm: 'siren' }
const TYPE_LABEL = { nvr: 'NVR/DVR', camera: 'Cámara', intercom: 'Portero', alarm: 'Alarma' }

export default function DeviceDiscover() {
  const navigate = useNavigate()
  const [mode, setMode] = useState('scan')
  return (
    <div className="anim-rise">
      <PageHead title="Descubrir equipo" subtitle="Encontrá cámaras, NVR y porteros de la red y registralos con un clic."
        actions={<Button variant="ghost" icon="chevron" onClick={() => navigate('/admin/devices')}>Volver a dispositivos</Button>} />
      <div className="u-mt-8" style={{ marginBottom: 14 }}>
        <Segmented value={mode} onChange={setMode} options={MODES} />
      </div>
      {mode === 'scan' ? <ScanMode navigate={navigate} /> : <ProbeMode navigate={navigate} />}
    </div>
  )
}

// ── Escaneo por rango ────────────────────────────────────────────────────────
function ScanMode({ navigate }) {
  const toast = useToast()
  const [form, setForm] = useState({ base: '192.168.99', from: 1, to: 254, user: 'admin', pass: '', onvif: true })
  const [busy, setBusy] = useState(false)
  const [res, setRes] = useState(null)
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))

  const run = async () => {
    const base = String(form.base || '').trim().replace(/\.+$/, '')
    if (base.split('.').filter(Boolean).length < 3) { toast('Base de red inválida (ej. 192.168.99)', 'error'); return }
    setBusy(true); setRes(null)
    try {
      const r = await api.post('/discover/scan', { base, from: Number(form.from) || 1, to: Number(form.to) || 254, user: form.user, pass: form.pass, onvif: form.onvif })
      setRes(r)
      toast(`${r.hosts?.length || 0} equipo(s) en ${r.scanned} IPs`)
    } catch (e) { toast(e.message || 'No se pudo escanear', 'error') }
    finally { setBusy(false) }
  }

  const add = (h) => {
    const last = h.ip.split('.').pop()
    const isHik = /hik/i.test(h.vendor || '')
    navigate('/admin/devices/new', {
      state: {
        prefill: {
          name: h.name || `${h.vendor || 'Equipo'} ${last}`,
          type: isHik ? 'hikvision' : 'generic',
          vendor: isHik ? 'Hikvision' : (h.vendor || ''),
          ip: h.ip, channel: 1,
          username: form.user || '', password: form.pass || '',
        },
      },
    })
  }

  return (
    <Panel title={<span className="ptitle"><Icon name="search" size={16} /> Escanear un rango de IPs</span>}
      subtitle="WS-Discovery + barrido TCP + ISAPI. Con credenciales identifica marca/modelo/MAC y si autentica.">
      <div className="form-grid form-grid--2">
        <Field label={<><Icon name="globe" size={14} /> Base de red</>} hint="Primeros 3 octetos.">
          <TextInput value={form.base} onChange={set('base')} placeholder="192.168.99" />
        </Field>
        <Field label={<><Icon name="hash" size={14} /> Rango (desde–hasta)</>} hint="Último octeto.">
          <div className="dscan__range">
            <TextInput type="number" min="0" max="255" value={form.from} onChange={set('from')} className="tnum" />
            <span className="dscan__dash">–</span>
            <TextInput type="number" min="0" max="255" value={form.to} onChange={set('to')} className="tnum" />
          </div>
        </Field>
        <Field label={<><Icon name="user" size={14} /> Usuario</>} hint="Para identificar marca/modelo y estado.">
          <TextInput value={form.user} onChange={set('user')} placeholder="admin" autoComplete="off" />
        </Field>
        <Field label={<><Icon name="shield" size={14} /> Contraseña</>}>
          <TextInput type="password" value={form.pass} onChange={set('pass')} placeholder="••••••••" autoComplete="new-password" />
        </Field>
        <Field label={<><Icon name="online" size={14} /> ONVIF (WS-Discovery)</>} hint="Descubre equipos de otras marcas.">
          <Switch checked={form.onvif} onChange={(v) => setForm((f) => ({ ...f, onvif: v }))} label={form.onvif ? 'Sí' : 'No'} />
        </Field>
      </div>
      <Button variant="primary" icon={busy ? undefined : 'search'} disabled={busy} onClick={run} className="u-mt-12">
        {busy ? <><Spinner size={15} /> Escaneando {form.base}.{form.from}–{form.to}…</> : 'Escanear la red'}
      </Button>

      {busy && (
        <div className="dscan__scanning u-mt-16">
          <span className="dscan__radar"><span /><span /><span /></span>
          <span>Barriendo <b className="tnum">{form.base}.{form.from}–{form.to}</b> — WS-Discovery + TCP 80/554 + ISAPI…</span>
        </div>
      )}

      {res && !busy && (
        res.hosts?.length ? (
          <div className="dscan__results u-mt-16">
            <p className="section-label"><Icon name="device" size={14} /> {res.hosts.length} equipo(s) encontrados <span className="muted">· {res.scanned} IPs barridas</span></p>
            <div className="adm-table-wrap">
              <table className="adm-table dscan__table">
                <thead><tr><th>Dirección</th><th>Marca / Modelo</th><th>MAC</th><th>Tipo</th><th>Estado</th><th /></tr></thead>
                <tbody>
                  {res.hosts.map((h, i) => (
                    <tr key={h.ip} className="dscan__row" style={{ animationDelay: `${Math.min(i, 20) * 45}ms` }}>
                      <td className="cell-mono dscan__ip"><span className="dscan__dot" /> {h.ip}</td>
                      <td>
                        <div className="dscan__brand">{h.vendor || '—'}</div>
                        {(h.model || h.fw) && <div className="muted dscan__sub">{[h.model, h.fw].filter(Boolean).join(' · ')}</div>}
                      </td>
                      <td className="cell-mono dscan__mac">{h.mac || <span className="muted">—</span>}</td>
                      <td><span className="dscan__type"><Icon name={TYPE_ICON[h.type] || 'device'} size={14} /> {TYPE_LABEL[h.type] || h.type || '—'}</span></td>
                      <td>
                        {h.auth === 'ok' ? <Badge tone="ok">Autenticado</Badge>
                          : h.auth === 'need' ? <Badge tone="warn">Necesita credenciales</Badge>
                            : <Badge tone="neutral">{(h.via || []).join(' · ') || 'Abierto'}</Badge>}
                      </td>
                      <td className="cell-actions">
                        <Button variant="primary" size="sm" icon="plus" onClick={() => add(h)}>Agregar</Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <div className="dscan__empty u-mt-16"><Icon name="search" size={22} /><p>No se encontraron equipos en ese rango. Probá con credenciales o revisá que la red sea la correcta.</p></div>
        )
      )}
    </Panel>
  )
}

// ── Sonda de un equipo puntual (NVR → canales) ───────────────────────────────
function ProbeMode({ navigate }) {
  const toast = useToast()
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
    <Panel title={<span className="ptitle"><Icon name="search" size={16} /> Sondear un equipo</span>}
      subtitle="Lista canales, analíticas configuradas y rutas RTSP de un NVR o cámara puntual.">
      <Field label={<><Icon name="sliders" size={14} /> Protocolo</>} hint="ISAPI para Hikvision; ONVIF (Perfil M) para otros fabricantes compatibles.">
        <Segmented value={form.protocol} onChange={(v) => setForm((f) => ({ ...f, protocol: v }))} options={PROTOCOLS} />
      </Field>
      <div className="form-grid form-grid--2 u-mt-12">
        <Field label={<><Icon name="globe" size={14} /> Host / IP</>}>
          <TextInput value={form.host} onChange={set('host')} placeholder="192.168.1.10" autoFocus />
        </Field>
        <Field label={<><Icon name="hash" size={14} /> Puerto</>} hint="Vacío = 80 (o 443 con HTTPS).">
          <TextInput value={form.port} onChange={set('port')} placeholder="80" className="tnum" />
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
  )
}

function DiscoverResult({ result, conn, navigate }) {
  const d = result.device
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
          rtspUrl: stream?.rtsp || '', username: conn.user || '', password: conn.pass || '',
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
        <p className="help-block u-mt-12" style={{ color: 'var(--warn)' }}>Avisos: {result.errors.join(' · ')}</p>
      )}
    </div>
  )
}
