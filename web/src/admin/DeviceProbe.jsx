// DeviceProbe — modal "Test de conectividad e importación de recursos".
// Sondea el equipo (ISAPI Hikvision) con las credenciales de la ficha, muestra
// un paso a paso animado (conectar → auth → canales → analíticas → relés) y
// permite importar lo descubierto a la ficha (RTSP + relés) o crear un
// dispositivo por cada canal (útil para NVR).
import { useEffect, useRef, useState } from 'react'
import { Modal, Button, Icon, Badge, Spinner } from '../ui/primitives.jsx'
import { api, collectionApi } from '../lib/adminApi.js'

const STAGES = [
  { key: 'conn', icon: 'globe', label: 'Conectando al equipo' },
  { key: 'auth', icon: 'shield', label: 'Autenticando (digest)' },
  { key: 'chan', icon: 'camera', label: 'Enumerando canales' },
  { key: 'ana', icon: 'filter', label: 'Leyendo analíticas' },
  { key: 'relay', icon: 'route', label: 'Detectando relés / salidas' },
  { key: 'done', icon: 'check', label: 'Listo' },
]
const HOLD = STAGES.length - 2 // último paso "en vuelo" antes de resolver

// Elige el stream principal (…01) del canal indicado.
function streamForChannel(streams, ch) {
  const list = streams || []
  const n = Number(ch)
  const same = list.filter((s) => Math.floor(Number(s.id) / 100) === n)
  return same.find((s) => String(s.id).endsWith('01')) || same[0] || null
}

export default function DeviceProbe({ device, onClose, onImport, onProbed, onCreated, toast }) {
  const [stage, setStage] = useState(0)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [running, setRunning] = useState(false)
  const [creating, setCreating] = useState(null) // id de canal en curso
  const [created, setCreated] = useState({})      // id de canal → id del dispositivo creado
  const ivRef = useRef(null)

  const run = () => {
    setResult(null); setError(null); setRunning(true); setStage(0)
    let cur = 0
    clearInterval(ivRef.current)
    ivRef.current = setInterval(() => {
      cur = Math.min(cur + 1, HOLD)
      setStage(cur)
      if (cur >= HOLD) clearInterval(ivRef.current)
    }, 640)
    // Descubridor por fabricante (cadena de protocolos, primero el que aplica):
    //  Hikvision → ISAPI (con ONVIF/RTSP de respaldo).
    //  Tiandy    → RTSP (no expone ISAPI ni ONVIF): enumera canales por ffprobe.
    //  Dahua/Uniview/Siera/Intelbras/ONVIF/genérico → ONVIF, con RTSP de respaldo.
    const V = (device.vendor || '').toLowerCase()
    const chain = /hik/.test(V) ? ['hikvision', 'onvif', 'rtsp']
      : /tiandy/.test(V) ? ['rtsp']
        : ['onvif', 'rtsp']
    const attempt = (protocol) => api.post('/discover', {
      protocol, host: device.ip, port: device.isapiPort || undefined,
      user: device.username, pass: device.password, https: !!device.https,
      vendor: device.vendor || undefined, rtspPort: device.rtspPort || undefined,
    })
    const tryChain = async () => {
      let last = null
      for (const p of chain) {
        try { const r = await attempt(p); if (r && r.device) return r; last = r || last } catch { /* sigue con el próximo */ }
      }
      return last
    }
    tryChain()
      .then((r) => {
        clearInterval(ivRef.current); setResult(r)
        if (r && r.device) { setStage(STAGES.length - 1); onProbed?.(r) }
        else setStage(0) // fallo → el primer paso queda en error
      })
      .catch((e) => { clearInterval(ivRef.current); setError(e.message || 'No se pudo conectar con el equipo'); setStage(0) })
      .finally(() => setRunning(false))
  }

  useEffect(() => { run(); return () => clearInterval(ivRef.current) }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const failed = result && !result.device
  const d = result?.device
  const chans = result?.channels || []
  const streams = result?.streams || []
  const analytics = result?.analytics || []
  const outputs = result?.outputs || []

  const importToFicha = () => {
    const patch = {}
    const st = streamForChannel(streams, device.channel || 1)
    if (st?.rtsp) patch.rtspUrl = st.rtsp
    if (outputs.length) patch.relays = outputs.map((o) => ({ name: o.name || `Salida ${o.id}`, output: String(o.id), kind: 'open' }))
    if (d?.model && !device.vendor) patch.vendor = d.model
    if (!Object.keys(patch).length) { toast?.('No hay recursos aplicables a esta ficha', 'error'); return }
    onImport(patch)
    const bits = []
    if (patch.rtspUrl) bits.push('RTSP')
    if (patch.relays) bits.push(`${patch.relays.length} relé(s)`)
    toast?.(`Importado a la ficha: ${bits.join(' + ')}`)
    onClose()
  }

  const importRelays = () => {
    if (!outputs.length) return
    onImport({ relays: outputs.map((o) => ({ name: o.name || `Salida ${o.id}`, output: String(o.id), kind: 'open' })) })
    toast?.(`${outputs.length} relé(s) importados a la ficha`)
  }

  // Crea la cámara del canal DIRECTO por API (ya tenemos todos los datos) — sin
  // navegar a la ficha de alta (eso abría el selector de vendor detrás del modal).
  const createFromChannel = async (c) => {
    if (created[c.id] || creating != null) return
    setCreating(c.id)
    const st = streamForChannel(streams, c.id)
    const payload = {
      name: c.name || `${d?.name || 'Cámara'} ${c.id}`, type: 'camera',
      vendor: device.vendor || d?.model || '',
      ip: c.ip || device.ip, channel: c.id || 1, rtspUrl: st?.rtsp || '',
      username: device.username, password: device.password || '',
      isapiPort: device.isapiPort || '', rtspPort: device.rtspPort || '',
      siteId: device.siteId || '',   // hereda el sitio del NVR → queda asociada
    }
    try {
      const res = await collectionApi('devices').create(payload)
      const newId = res?.id || res?.device?.id || true
      setCreated((m) => ({ ...m, [c.id]: newId }))
      toast?.(`Cámara «${payload.name}» creada`)
      onCreated?.(res)
    } catch (e) {
      toast?.(e.message || 'No se pudo crear la cámara', 'error')
    } finally { setCreating(null) }
  }

  const footer = (
    <>
      <Button variant="ghost" onClick={onClose}>Cerrar</Button>
      <span style={{ flex: 1 }} />
      {(result || error) && <Button variant="secondary" icon="search" disabled={running} onClick={run}>Reintentar</Button>}
      {result && !failed && (
        <Button variant="primary" icon="check" onClick={importToFicha}>Importar a esta ficha</Button>
      )}
    </>
  )

  return (
    <Modal open title={<span className="ptitle"><Icon name="search" size={16} /> Test de conectividad e importación</span>}
      size="lg" onClose={onClose} footer={footer}>
      <p className="help-block" style={{ marginTop: 0 }}>
        Sondeando <b>{device.ip || '—'}</b>{device.isapiPort ? `:${device.isapiPort}` : ''} con el usuario <b>{device.username || '—'}</b>. Detecta canales, analíticas y relés del equipo para importarlos.
      </p>

      <div className="probe-steps">
        {STAGES.map((s, i) => {
          const isFail = !!error || failed
          const done = !isFail && ((result && i < STAGES.length - 1) || (result && i === STAGES.length - 1) || i < stage)
          const active = !result && !error && !isFail && i === stage
          const stalled = isFail && i === stage
          return (
            <div key={s.key} className={`probe-step${active ? ' is-active' : ''}${done ? ' is-done' : ''}${stalled ? ' is-error' : ''}`}>
              <span className="probe-step__ic">
                {active ? <Spinner size={16} /> : <Icon name={done ? 'check' : stalled ? 'alert' : s.icon} size={16} />}
              </span>
              <span className="probe-step__lbl">{s.label}</span>
              {done && <Icon name="check" size={15} className="probe-step__tick" />}
            </div>
          )
        })}
      </div>

      {error && (
        <div className="probe-error">
          <Icon name="alert" size={16} />
          <span>{error}</span>
        </div>
      )}

      {failed && (
        <>
          <div className="probe-error">
            <Icon name="alert" size={16} />
            <span>No se pudo descubrir el equipo. {result.errors?.length ? result.errors.join(' · ') : 'Revisá IP, puerto, usuario/clave y red.'}</span>
          </div>
          <p className="help-block u-mt-12">
            Se probó según el fabricante ({device.vendor || 'genérico'}): ISAPI, ONVIF y/o RTSP. Verificá <b>usuario/clave</b>, el <b>puerto RTSP</b> (554) y que la <b>plantilla RTSP</b> del fabricante sea correcta (en <b>Configuración › Plantillas RTSP</b>). También podés cargar el canal manualmente con su RTSP.
          </p>
        </>
      )}

      {result && !failed && (
        <div className="probe-result anim-rise">
          <div className="discover__dev">
            <span className="discover__dev-ic"><Icon name="device" size={20} /></span>
            <div className="discover__dev-info">
              <b>{d.name || 'Equipo'}</b>
              <span>{[d.model, d.deviceType, d.firmware].filter(Boolean).join(' · ') || '—'}</span>
              {d.serial && <span className="muted">S/N {d.serial}{d.mac ? ` · ${d.mac}` : ''}</span>}
            </div>
            <div className="probe-result__counts">
              <span className="probe-chip"><Icon name="camera" size={13} /> {chans.length} canal(es)</span>
              <span className="probe-chip"><Icon name="route" size={13} /> {outputs.length} relé(s)</span>
              <span className="probe-chip"><Icon name="filter" size={13} /> {analytics.length} analítica(s)</span>
            </div>
          </div>

          {chans.length > 0 && (
            <>
              <p className="section-label u-mt-16"><Icon name="camera" size={14} /> Canales</p>
              <div className="adm-table-wrap">
                <table className="adm-table">
                  <thead><tr><th>#</th><th>Nombre</th><th>IP</th><th>Estado</th><th /></tr></thead>
                  <tbody>
                    {chans.map((c, i) => (
                      <tr key={c.id || i}>
                        <td className="cell-mono">{c.id || '—'}</td>
                        <td className="cell-name">{c.name || '—'}</td>
                        <td className="cell-mono">{c.ip || '—'}</td>
                        <td>{c.online ? <Badge tone="ok">En línea</Badge> : <span className="muted">—</span>}</td>
                        <td className="cell-actions">
                          {created[c.id]
                            ? <span className="probe-created"><Icon name="check" size={14} /> Creado</span>
                            : <Button variant="ghost" size="sm" icon={creating === c.id ? undefined : 'plus'} disabled={creating != null} onClick={() => createFromChannel(c)}>
                                {creating === c.id ? <Spinner size={14} /> : 'Crear dispositivo'}
                              </Button>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {outputs.length > 0 && (
            <>
              <p className="section-label u-mt-16 section-label--action">
                <span><Icon name="route" size={14} /> Relés / salidas</span>
                <Button variant="secondary" size="sm" icon="plus" className="section-label__add" onClick={importRelays}>Importar {outputs.length} relé(s)</Button>
              </p>
              <div className="inline-tags">
                {outputs.map((o, i) => (
                  <Badge key={o.id || i} tone="neutral"><Icon name="route" size={12} /> {o.name || `Salida ${o.id}`} · #{o.id}</Badge>
                ))}
              </div>
            </>
          )}

          {analytics.length > 0 && (
            <>
              <p className="section-label u-mt-16"><Icon name="filter" size={14} /> Analíticas configuradas</p>
              <div className="inline-tags">
                {analytics.map((a, i) => <Badge key={i} tone="accent">{a.label}{a.channel ? ` · ch ${a.channel}` : ''}</Badge>)}
              </div>
            </>
          )}

          {streams.length > 0 && (
            <>
              <p className="section-label u-mt-16"><Icon name="video" size={14} /> Streams RTSP</p>
              <div className="endpoint-list">
                {streams.slice(0, 8).map((s, i) => (
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
      )}
    </Modal>
  )
}
