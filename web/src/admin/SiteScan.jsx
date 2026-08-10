// SiteScan — Escaneo de red desde la tab "Dispositivos" de un sitio.
// Barre un rango de la LAN (WS-Discovery ONVIF + TCP 80/554), identifica por ISAPI
// si se dan credenciales, y permite importar cada equipo encontrado AL SITIO.
import { useState } from 'react'
import { Button, Icon, TextInput, Switch, Badge, Spinner, Field } from '../ui/primitives.jsx'
import { api, collectionApi } from '../lib/adminApi.js'
import { useToast } from './_shared.jsx'

const TYPE_LABEL = { camera: 'Cámara', nvr: 'NVR', alarm: 'Alarma' }
const TYPE_ICON = { camera: 'camera', nvr: 'device', alarm: 'siren' }

export default function SiteScan({ siteId, defaultBase = '192.168.99', onImported }) {
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [base, setBase] = useState(defaultBase)
  const [from, setFrom] = useState(1)
  const [to, setTo] = useState(254)
  const [user, setUser] = useState('admin')
  const [pass, setPass] = useState('')
  const [onvif, setOnvif] = useState(true)
  const [busy, setBusy] = useState(false)
  const [res, setRes] = useState(null)
  const [imported, setImported] = useState({}) // ip → device id
  const [importing, setImporting] = useState(null)

  const runScan = async () => {
    setBusy(true); setRes(null); setImported({})
    try {
      const r = await api.post('/discover/scan', { base, from: Number(from), to: Number(to), user, pass, onvif })
      setRes(r)
      toast(`Escaneo: ${r.hosts?.length || 0} equipo(s) en ${r.scanned} IPs`)
    } catch (e) {
      toast(e.message || 'No se pudo escanear', 'error')
    } finally { setBusy(false) }
  }

  const importHost = async (h) => {
    if (imported[h.ip] || importing) return
    setImporting(h.ip)
    const payload = {
      name: h.name || `${TYPE_LABEL[h.type] || 'Equipo'} ${h.ip.split('.').pop()}`,
      type: h.type || 'camera',
      vendor: h.vendor && !['ONVIF', 'RTSP', 'Desconocido'].includes(h.vendor) ? h.vendor : (h.vendor || ''),
      ip: h.ip, siteId,
      isapiPort: h.ports?.includes(80) ? 80 : '',
      rtspPort: h.ports?.includes(554) ? 554 : '',
      username: user, password: pass, channel: h.type === 'nvr' ? undefined : 1,
    }
    try {
      const d = await collectionApi('devices').create(payload)
      setImported((m) => ({ ...m, [h.ip]: d?.id || true }))
      toast(`«${payload.name}» importado al sitio`)
      onImported?.(d)
    } catch (e) {
      toast(e.message || 'No se pudo importar', 'error')
    } finally { setImporting(null) }
  }

  return (
    <div className="netscan">
      <button type="button" className={`netscan__toggle${open ? ' is-open' : ''}`} onClick={() => setOpen((v) => !v)}>
        <Icon name="search" size={16} />
        <span><b>Escanear la red</b> — encontrar cámaras, NVR y equipos del sitio automáticamente</span>
        <Icon name="chevron" size={16} className="netscan__chev" />
      </button>

      {open && (
        <div className="netscan__panel anim-rise">
          <div className="netscan__form">
            <Field label={<><Icon name="globe" size={13} /> Red (3 primeros octetos)</>} hint="Ej. 192.168.99">
              <TextInput value={base} onChange={(e) => setBase(e.target.value)} placeholder="192.168.99" />
            </Field>
            <Field label="Desde"><TextInput type="number" min="0" max="255" value={from} onChange={(e) => setFrom(e.target.value)} className="tnum" /></Field>
            <Field label="Hasta"><TextInput type="number" min="0" max="255" value={to} onChange={(e) => setTo(e.target.value)} className="tnum" /></Field>
            <Field label={<><Icon name="user" size={13} /> Usuario</>} hint="Para identificar marca/modelo (ISAPI)">
              <TextInput value={user} onChange={(e) => setUser(e.target.value)} placeholder="admin" autoComplete="off" />
            </Field>
            <Field label={<><Icon name="shield" size={13} /> Contraseña</>}>
              <TextInput type="password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder="••••••••" autoComplete="new-password" />
            </Field>
            <Field label={<><Icon name="filter" size={13} /> ONVIF</>} hint="WS-Discovery multicast">
              <Switch checked={onvif} onChange={setOnvif} label={onvif ? 'Sí' : 'No'} />
            </Field>
          </div>
          <div className="netscan__actions">
            <p className="help-block" style={{ margin: 0 }}>Barre <b>{base}.{from}–{to}</b> por ONVIF + puertos 80/554. Puede tardar unos segundos.</p>
            <Button variant="primary" icon={busy ? undefined : 'search'} disabled={busy || !base} onClick={runScan}>
              {busy ? <><Spinner size={14} /> Escaneando…</> : 'Escanear'}
            </Button>
          </div>

          {busy && (
            <div className="netscan__scanning">
              <span className="netscan__radar"><span /><span /><span /></span>
              <span>Buscando equipos en <b>{base}.{from}–{to}</b>…</span>
            </div>
          )}

          {res && !busy && (
            res.hosts.length === 0
              ? <div className="netscan__empty"><Icon name="search" size={22} /><p>No se encontraron equipos en ese rango. Probá con credenciales o revisá la red.</p></div>
              : <div className="adm-table-wrap netscan__results">
                  <table className="adm-table">
                    <thead><tr><th>IP</th><th>Tipo</th><th>Marca / Modelo</th><th>Vías</th><th /></tr></thead>
                    <tbody>
                      {res.hosts.map((h) => (
                        <tr key={h.ip}>
                          <td className="cell-mono">{h.ip}</td>
                          <td><span className="netscan__type"><Icon name={TYPE_ICON[h.type] || 'device'} size={14} /> {TYPE_LABEL[h.type] || h.type}</span></td>
                          <td className="cell-name">{h.vendor}{h.model ? ` · ${h.model}` : ''}{h.name ? <span className="muted"> · {h.name}</span> : ''}</td>
                          <td>{(h.via || []).map((v) => <Badge key={v} tone="neutral">{v}</Badge>)}</td>
                          <td className="cell-actions">
                            {imported[h.ip]
                              ? <span className="probe-created"><Icon name="check" size={14} /> Importado</span>
                              : <Button variant="ghost" size="sm" icon={importing === h.ip ? undefined : 'plus'} disabled={importing != null} onClick={() => importHost(h)}>
                                  {importing === h.ip ? <Spinner size={14} /> : 'Importar al sitio'}
                                </Button>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
          )}
        </div>
      )}
    </div>
  )
}
