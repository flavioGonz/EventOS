// Puertas del sitio — asocia relés físicos (salidas de dispositivos del sitio) a
// "puertas" con nombre, para abrirlas desde el sitio o el popup del operador.
// Persiste en site.doors = [{ name, deviceId, output, note }].
import { useEffect, useMemo, useState } from 'react'
import { Button, Icon, Field, TextInput, Select, Spinner } from '../ui/primitives.jsx'
import { collectionApi } from '../lib/adminApi.js'
import { deviceTypeLabel } from '../lib/labels.js'
import { Loading, useToast } from './_shared.jsx'

const EMPTY_DOOR = { name: '', deviceId: '', output: '1', note: '' }

export default function SiteDoors({ siteId }) {
  const toast = useToast()
  const [doors, setDoors] = useState([])
  const [devices, setDevices] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let alive = true
    Promise.all([collectionApi('sites').get(siteId), collectionApi('devices').list()])
      .then(([site, devs]) => {
        if (!alive) return
        const list = Array.isArray(devs) ? devs : (devs && devs.devices) || []
        setDevices(list.filter((d) => d.siteId === siteId))
        setDoors(Array.isArray(site && site.doors) ? site.doors.map((d) => ({ ...EMPTY_DOOR, ...d })) : [])
      })
      .catch((e) => toast(e.message || 'No se pudo cargar', 'error'))
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [siteId]) // eslint-disable-line react-hooks/exhaustive-deps

  const byId = useMemo(() => new Map(devices.map((d) => [d.id, d])), [devices])
  const withRelays = useMemo(() => devices.filter((d) => Array.isArray(d.relays) && d.relays.length), [devices])

  const add = () => setDoors((ds) => [...ds, { ...EMPTY_DOOR }])
  const upd = (i, patch) => setDoors((ds) => ds.map((d, j) => (j === i ? { ...d, ...patch } : d)))
  const del = (i) => setDoors((ds) => ds.filter((_, j) => j !== i))

  // Importa como puertas todos los relés ya definidos en los dispositivos del sitio.
  const importRelays = () => setDoors((ds) => {
    const have = new Set(ds.map((d) => `${d.deviceId}:${d.output}`))
    const add = []
    for (const dev of withRelays) {
      for (const r of dev.relays) {
        const out = String(r.output ?? '1')
        const k = `${dev.id}:${out}`
        if (have.has(k)) continue
        have.add(k)
        add.push({ name: r.name || `${dev.name} · salida ${out}`, deviceId: dev.id, output: out, note: '' })
      }
    }
    if (!add.length) { toast('No hay relés nuevos para importar'); return ds }
    toast(`${add.length} puerta(s) importada(s) — revisá y guardá`)
    return [...ds, ...add]
  })

  const save = async () => {
    setSaving(true)
    const clean = doors
      .filter((d) => (d.name || '').trim() && d.deviceId)
      .map((d) => ({ name: d.name.trim(), deviceId: d.deviceId, output: String(d.output ?? '1'), note: (d.note || '').trim() }))
    try {
      await collectionApi('sites').update(siteId, { doors: clean })
      setDoors(clean.map((d) => ({ ...EMPTY_DOOR, ...d })))
      toast('Puertas guardadas')
    } catch (e) { toast(e.message || 'No se pudo guardar', 'error') }
    setSaving(false)
  }

  const openDoor = async (d) => {
    const dev = byId.get(d.deviceId)
    if (!dev) { toast('Elegí un dispositivo válido', 'error'); return }
    if (!window.confirm(`¿Abrir "${d.name || 'puerta'}" ahora? Esto acciona la salida física de ${dev.name}.`)) return
    try {
      const res = await fetch(`/api/device/${dev.id}/relay`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ output: d.output, cmd: 'open', confirmed: true, operatorId: 'admin' }),
      })
      const j = await res.json()
      if (j.ok) toast(`Puerta accionada — ${d.name || 'salida ' + d.output}`)
      else toast(`El equipo no respondió OK (${j.status || j.error || '—'})`, 'error')
    } catch (e) { toast(e.message || 'No se pudo accionar', 'error') }
  }

  if (loading) return <Loading label="Cargando puertas…" />

  return (
    <div className="doors anim-rise">
      <div className="doors__head">
        <div>
          <p className="section-label"><Icon name="route" size={15} /> Puertas del sitio</p>
          <p className="help-block">Asociá un relé (salida física de un dispositivo del sitio) a cada puerta. El operador podrá abrirla por nombre. «Abrir» acciona el relé real y pide confirmación.</p>
        </div>
        <div className="doors__actions">
          {withRelays.length > 0 && <Button variant="secondary" size="sm" icon="download" onClick={importRelays}>Importar relés del sitio</Button>}
          <Button variant="primary" size="sm" icon={saving ? undefined : 'check'} disabled={saving} onClick={save}>
            {saving ? <Spinner size={14} /> : 'Guardar puertas'}
          </Button>
        </div>
      </div>

      {devices.length === 0 && (
        <div className="doors__empty"><Icon name="device" size={18} /> Este sitio no tiene dispositivos. Asigná dispositivos al sitio para poder mapear sus relés a puertas.</div>
      )}

      <div className="doorlist">
        {doors.length === 0 && (
          <div className="doors__empty"><Icon name="route" size={18} /> Sin puertas. Agregá una o usá «Importar relés del sitio».</div>
        )}
        {doors.map((d, i) => {
          const dev = byId.get(d.deviceId)
          const relays = dev && Array.isArray(dev.relays) ? dev.relays : []
          return (
            <div className="doorrow" key={i}>
              <Field label={<><Icon name="route" size={13} /> Puerta</>} className="doorrow__name">
                <TextInput value={d.name} placeholder="Portón principal" onChange={(e) => upd(i, { name: e.target.value })} />
              </Field>
              <Field label={<><Icon name="device" size={13} /> Dispositivo</>} className="doorrow__dev">
                <Select value={d.deviceId} onChange={(e) => upd(i, { deviceId: e.target.value })}>
                  <option value="">— Elegir —</option>
                  {devices.map((x) => <option key={x.id} value={x.id}>{x.name} · {deviceTypeLabel(x.type)}</option>)}
                </Select>
              </Field>
              <Field label={<><Icon name="hash" size={13} /> Salida</>} className="doorrow__out">
                {relays.length > 0 ? (
                  <Select value={String(d.output ?? '1')} onChange={(e) => upd(i, { output: e.target.value })}>
                    {relays.map((r, j) => <option key={j} value={String(r.output ?? '1')}>{r.name ? `${r.name} (${r.output ?? 1})` : `Salida ${r.output ?? 1}`}</option>)}
                    {!relays.some((r) => String(r.output ?? '1') === String(d.output ?? '1')) && <option value={String(d.output ?? '1')}>Salida {d.output}</option>}
                  </Select>
                ) : (
                  <TextInput type="number" min="1" value={d.output ?? '1'} onChange={(e) => upd(i, { output: e.target.value })} />
                )}
              </Field>
              <div className="doorrow__ctl">
                <Button variant="secondary" icon="route" disabled={!d.deviceId} onClick={() => openDoor(d)}>Abrir</Button>
                <Button variant="ghost" icon="trash" onClick={() => del(i)} aria-label="Quitar" />
              </div>
            </div>
          )
        })}
        <Button variant="ghost" size="sm" icon="plus" onClick={add} className="u-mt-8">Agregar puerta</Button>
      </div>
    </div>
  )
}
