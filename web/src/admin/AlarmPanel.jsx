// AlarmPanel — panel de control estético para dispositivos de tipo "alarma".
// Estado armado/desarmado, botón de pánico, interruptores de relé (salidas
// físicas) y últimos eventos del equipo. Las acciones de relé y pánico pegan a
// endpoints de acción; el estado armado se guarda con la ficha.
//
// Para paneles Hik AX (SecurityCP) suma un tablero EN VIVO: salud del host
// (batería / red / corriente / sabotaje), subsistemas (armado), zonas con
// apertura de puerta/ventana y estado real (on/off) de cada relé. Todo por
// GET /api/device/:id/ax-status (solo lectura). Accionar un relé SIGUE pidiendo
// confirmación explícita del operador — nada físico se dispara solo.
import { useEffect, useState, useCallback } from 'react'
import { Icon, Button, Badge, Switch } from '../ui/primitives.jsx'
import { testDeviceAlert } from '../lib/adminApi.js'
import { apiFetch } from '../lib/eventsApi.js'
import { eventTypeLabel } from '../lib/labels.js'

const fmtClock = (ts) => { try { return new Date(ts).toLocaleString([], { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) } catch { return '—' } }

// ¿Este dispositivo es un panel de alarma AX (SecurityCP)? Heurística por la
// ficha; si acierta, se muestra el tablero en vivo. Si no, se oculta silencioso.
function isAxDevice(device) {
  const k = String(device.relayKind || device.doorKind || '').toLowerCase()
  if (k === 'ax') return true
  const t = `${device.type || ''} ${device.model || ''} ${device.vendor || ''} ${device.subtype || ''}`.toLowerCase()
  return /ax\s*pro|axpro|axhybrid|securitycp|hik.*alarm|alarm.*hik/.test(t)
}

// Chip de salud: icono + etiqueta + valor, coloreado por tono (ok/warn/crit/na).
function HealthChip({ icon, label, value, tone = 'na' }) {
  return (
    <div className={`axhealth__chip is-${tone}`}>
      <Icon name={icon} size={16} />
      <span className="axhealth__lbl">{label}</span>
      <b className="axhealth__val">{value}</b>
    </div>
  )
}

export default function AlarmPanel({ device, id, isNew, armed, onArmed, toast }) {
  const [events, setEvents] = useState(null)
  const [busy, setBusy] = useState('')
  const [ax, setAx] = useState(null)          // estado en vivo del panel AX (o null)
  const [axLoading, setAxLoading] = useState(false)
  const relays = device.relays || []
  const showAx = !isNew && !!id && isAxDevice(device)

  useEffect(() => {
    if (isNew || !id) { setEvents([]); return }
    let alive = true
    apiFetch('/api/events?limit=60').then((r) => (r.ok ? r.json() : null)).then((d) => {
      if (!alive) return
      const list = Array.isArray(d) ? d : (d?.events || [])
      const mine = list.filter((e) => e && (e.deviceId === id || e.source?.deviceId === id || e.source?.id === id || (device.name && e.source?.name === device.name))).slice(0, 6)
      setEvents(mine)
    }).catch(() => { if (alive) setEvents([]) })
    return () => { alive = false }
  }, [id, isNew, device.name])

  // Tablero AX en vivo: primer tiro inmediato + refresco cada 12 s.
  const loadAx = useCallback((withSpinner) => {
    if (!showAx) return
    if (withSpinner) setAxLoading(true)
    fetch(`/api/device/${id}/ax-status`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d) setAx(d) })
      .catch(() => {})
      .finally(() => setAxLoading(false))
  }, [id, showAx])

  useEffect(() => {
    if (!showAx) { setAx(null); return }
    loadAx(true)
    const t = setInterval(() => loadAx(false), 12000)
    return () => clearInterval(t)
  }, [showAx, loadAx])

  const panic = async () => {
    if (isNew) { toast?.('Guardá el dispositivo primero', 'error'); return }
    setBusy('panic')
    try { const r = await testDeviceAlert(id); toast?.(`Pánico enviado a la consola (P${r.priority})`) }
    catch (e) { toast?.(e.message || 'No se pudo enviar', 'error') }
    finally { setBusy('') }
  }

  const fireRelay = async (r) => {
    if (isNew) { toast?.('Guardá el dispositivo primero', 'error'); return }
    if (!window.confirm(`¿Accionar "${r.name || 'relé ' + r.output}" ahora? Acciona la salida física.`)) return
    setBusy(`relay-${r.output}`)
    try {
      const res = await fetch(`/api/device/${id}/relay`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ output: r.output, cmd: r.kind || 'open', confirmed: true, operatorId: 'admin' }) })
      const d = await res.json()
      if (d.ok) { toast?.(`Relé accionado — ${r.name || 'salida ' + r.output}`); setTimeout(() => loadAx(false), 1200) }
      else toast?.(`El equipo no respondió OK (${d.status || d.error || '—'})`, 'error')
    } catch (e) { toast?.(e.message || 'No se pudo accionar', 'error') }
    finally { setBusy('') }
  }

  // Estado real (on/off) de una salida, tomado del tablero AX si está disponible.
  const relayLiveOn = (output) => {
    const list = (ax && ax.outputs) || []
    const m = list.find((o) => String(o.id) === String(output))
    return m ? m.on : null
  }

  return (
    <div className="alarmpanel">
      <div className={`alarmpanel__stage ${armed ? 'is-armed' : 'is-disarmed'}`}>
        <button type="button" className="alarmpanel__dial" onClick={() => onArmed(!armed)} aria-pressed={armed}
          title={armed ? 'Desarmar' : 'Armar'}>
          <span className="alarmpanel__ring" />
          <span className="alarmpanel__ic"><Icon name={armed ? 'shield' : 'device'} size={30} /></span>
          <span className="alarmpanel__state">{armed ? 'ARMADO' : 'DESARMADO'}</span>
        </button>
        <div className="alarmpanel__arm">
          <Switch checked={!!armed} onChange={(v) => onArmed(v)} label={armed ? 'Sistema armado' : 'Sistema desarmado'} />
          <span className="help-block">{isNew ? 'Se guarda al Guardar la ficha.' : 'El estado se guarda con la ficha.'}</span>
        </div>
        <Button variant="secondary" size="sm" icon="siren" className="alarmpanel__panic" disabled={busy === 'panic'} onClick={panic}>
          {busy === 'panic' ? 'Enviando…' : 'Pánico / prueba'}
        </Button>
      </div>

      {showAx && <AxStatusBlock ax={ax} loading={axLoading} onRefresh={() => loadAx(true)} />}

      <div className="alarmpanel__block">
        <p className="section-label"><Icon name="route" size={14} /> Relés / salidas</p>
        {relays.length === 0 ? (
          <div className="relay-empty"><Icon name="route" size={15} /> Sin relés. Agregalos en la sección «Relés / Puertas».</div>
        ) : (
          <div className="alarmpanel__relays">
            {relays.map((r, i) => {
              const on = relayLiveOn(r.output)
              return (
                <button type="button" key={i} className={`relaytile ${on === true ? 'is-on' : on === false ? 'is-off' : ''}`} disabled={isNew || busy === `relay-${r.output}`} onClick={() => fireRelay(r)}>
                  <span className="relaytile__sw"><span className="relaytile__knob" /></span>
                  <span className="relaytile__meta">
                    <b>{r.name || `Salida ${r.output}`}</b>
                    <span>#{r.output}{on != null ? ` · ${on ? 'activo' : 'en reposo'}` : ''}</span>
                  </span>
                  <Icon name="route" size={15} className="relaytile__go" />
                </button>
              )
            })}
          </div>
        )}
      </div>

      <div className="alarmpanel__block">
        <p className="section-label"><Icon name="bell" size={14} /> Últimos eventos</p>
        {events === null ? (
          <div className="relay-empty"><Icon name="clock" size={15} /> Cargando…</div>
        ) : events.length === 0 ? (
          <div className="relay-empty"><Icon name="bell" size={15} /> {isNew ? 'Guardá el dispositivo para ver su actividad.' : 'Sin eventos recientes de este equipo.'}</div>
        ) : (
          <div className="alarmpanel__log">
            {events.map((e, i) => (
              <div className="alarmlog" key={e.id || i}>
                <span className={`alarmlog__dot p${e.priority ?? 5}`} />
                <span className="alarmlog__t"><b>{eventTypeLabel(e.type)}</b><span>{fmtClock(e.ts)}</span></span>
                {e.status && <Badge tone={e.status === 'resolved' ? 'ok' : 'neutral'}>{e.status}</Badge>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// AxStatusBlock — tablero EN VIVO del panel AX: salud + subsistemas + zonas.
function AxStatusBlock({ ax, loading, onRefresh }) {
  const host = (ax && ax.host) || {}
  const batt = host.battery || null
  const net = host.network || null
  const zones = (ax && ax.zones) || []
  const subs = (ax && ax.subsystems) || []
  const reachable = ax && ax.ok

  // Salud → chips. Sólo mostramos lo que el equipo reportó (null = "s/d").
  const battTone = batt == null ? 'na' : batt.low ? 'crit' : (batt.percent != null && batt.percent < 50 ? 'warn' : 'ok')
  const battVal = batt == null ? 's/d'
    : (batt.percent != null ? `${batt.percent}%` : (batt.charging === true ? 'cargando' : (batt.status || 'ok')))
    + (batt.charging === true && batt.percent != null ? ' ⚡' : '')
  const netTone = net == null ? 'na' : net.online === true ? 'ok' : net.online === false ? 'crit' : 'na'
  const netVal = net == null ? 's/d' : net.online === true ? (net.type || 'conectada') : net.online === false ? 'caída' : 's/d'
  const acTone = host.ac == null ? 'na' : host.ac ? 'ok' : 'crit'
  const acVal = host.ac == null ? 's/d' : host.ac ? 'presente' : 'sin AC'
  const tamperTone = host.tamper == null ? 'na' : host.tamper ? 'crit' : 'ok'
  const tamperVal = host.tamper == null ? 's/d' : host.tamper ? '¡sabotaje!' : 'cerrado'

  const openZones = zones.filter((z) => z.open === true)
  const alarmZones = zones.filter((z) => z.alarm === true)

  return (
    <div className="alarmpanel__block axstatus">
      <p className="section-label">
        <Icon name="gauge" size={14} /> Estado en vivo (AX)
        <span className={`axstatus__live ${reachable ? 'is-up' : 'is-down'}`}>{reachable ? 'en línea' : 'sin respuesta'}</span>
        <button type="button" className="axstatus__refresh" onClick={onRefresh} title="Actualizar ahora" disabled={loading}>
          <Icon name="refresh" size={13} /> {loading ? '…' : 'Actualizar'}
        </button>
      </p>

      {ax == null ? (
        <div className="relay-empty"><Icon name="clock" size={15} /> Consultando el panel…</div>
      ) : !reachable ? (
        <div className="relay-empty"><Icon name="alert" size={15} /> El panel no respondió por SecurityCP (revisá IP/credenciales/red).</div>
      ) : (
        <>
          <div className="axhealth">
            <HealthChip icon="bolt" label="Batería" value={battVal} tone={battTone} />
            <HealthChip icon="globe" label="Red" value={netVal} tone={netTone} />
            <HealthChip icon="bolt" label="Alimentación" value={acVal} tone={acTone} />
            <HealthChip icon="shield" label="Gabinete" value={tamperVal} tone={tamperTone} />
          </div>

          {subs.length > 0 && (
            <div className="axsubs">
              {subs.map((s, i) => {
                const isArmed = /arm|armado|away|stay/i.test(String(s.armMode || '')) && !/disarm|desarm/i.test(String(s.armMode || ''))
                return (
                  <span key={i} className={`axsub ${isArmed ? 'is-armed' : 'is-disarmed'}`}>
                    <Icon name={isArmed ? 'shield' : 'device'} size={12} />
                    {s.name || `Subsistema ${s.id}`}
                    <b>{s.armMode || (isArmed ? 'armado' : 'desarmado')}</b>
                  </span>
                )
              })}
            </div>
          )}

          <div className="axzones">
            <div className="axzones__head">
              <Icon name="zone" size={13} /> Zonas
              {openZones.length > 0 && <span className="axzones__tag is-open">{openZones.length} abierta{openZones.length > 1 ? 's' : ''}</span>}
              {alarmZones.length > 0 && <span className="axzones__tag is-alarm">{alarmZones.length} en alarma</span>}
            </div>
            {zones.length === 0 ? (
              <div className="relay-empty"><Icon name="zone" size={15} /> El panel no expuso zonas.</div>
            ) : (
              <div className="axzones__grid">
                {zones.map((z, i) => {
                  const tone = z.alarm ? 'alarm' : z.tamper ? 'tamper' : z.open ? 'open' : z.online === false ? 'offline' : 'ok'
                  return (
                    <div key={z.id ?? i} className={`axzone is-${tone}`} title={z.type || ''}>
                      <span className="axzone__dot" />
                      <span className="axzone__name">{z.name || `Zona ${z.id}`}</span>
                      <span className="axzone__st">
                        {z.alarm ? 'ALARMA' : z.tamper ? 'sabotaje' : z.open ? 'abierta' : z.online === false ? 'offline' : 'cerrada'}
                        {z.bypass ? ' · anulada' : ''}
                        {z.lowBattery ? ' · batería baja' : ''}
                      </span>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
