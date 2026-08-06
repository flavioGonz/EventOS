// AlarmPanel — panel de control estético para dispositivos de tipo "alarma".
// Estado armado/desarmado, botón de pánico, interruptores de relé (salidas
// físicas) y últimos eventos del equipo. Las acciones de relé y pánico pegan a
// endpoints de acción; el estado armado se guarda con la ficha.
import { useEffect, useState } from 'react'
import { Icon, Button, Badge, Switch } from '../ui/primitives.jsx'
import { testDeviceAlert } from '../lib/adminApi.js'
import { eventTypeLabel } from '../lib/labels.js'

const fmtClock = (ts) => { try { return new Date(ts).toLocaleString([], { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) } catch { return '—' } }

export default function AlarmPanel({ device, id, isNew, armed, onArmed, toast }) {
  const [events, setEvents] = useState(null)
  const [busy, setBusy] = useState('')
  const relays = device.relays || []

  useEffect(() => {
    if (isNew || !id) { setEvents([]); return }
    let alive = true
    fetch(`/api/events?limit=60`).then((r) => (r.ok ? r.json() : null)).then((d) => {
      if (!alive) return
      const list = Array.isArray(d) ? d : (d?.events || [])
      const mine = list.filter((e) => e && (e.deviceId === id || e.source?.deviceId === id || e.source?.id === id || (device.name && e.source?.name === device.name))).slice(0, 6)
      setEvents(mine)
    }).catch(() => { if (alive) setEvents([]) })
    return () => { alive = false }
  }, [id, isNew, device.name])

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
      if (d.ok) toast?.(`Relé accionado — ${r.name || 'salida ' + r.output}`)
      else toast?.(`El equipo no respondió OK (${d.status || d.error || '—'})`, 'error')
    } catch (e) { toast?.(e.message || 'No se pudo accionar', 'error') }
    finally { setBusy('') }
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

      <div className="alarmpanel__block">
        <p className="section-label"><Icon name="route" size={14} /> Relés / salidas</p>
        {relays.length === 0 ? (
          <div className="relay-empty"><Icon name="route" size={15} /> Sin relés. Agregalos en la sección «Relés / Puertas».</div>
        ) : (
          <div className="alarmpanel__relays">
            {relays.map((r, i) => (
              <button type="button" key={i} className="relaytile" disabled={isNew || busy === `relay-${r.output}`} onClick={() => fireRelay(r)}>
                <span className="relaytile__sw"><span className="relaytile__knob" /></span>
                <span className="relaytile__meta">
                  <b>{r.name || `Salida ${r.output}`}</b>
                  <span>#{r.output}</span>
                </span>
                <Icon name="route" size={15} className="relaytile__go" />
              </button>
            ))}
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
