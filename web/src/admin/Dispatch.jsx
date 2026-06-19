// Balanceo — editor de la política de dispatch (PUT /api/admin/dispatch).
import { useEffect, useState } from 'react'
import {
  Panel, Button, Field, TextInput, Switch, Segmented, Icon, Spinner,
} from '../ui/primitives.jsx'
import { getDispatch, putDispatch } from '../lib/adminApi.js'
import { seqStrategyLabel } from '../lib/labels.js'
import { PageHead, Loading, ErrorState, SectionHelp, useToast } from './_shared.jsx'

const MODES = [
  { value: 'simultaneous', icon: 'bell',    title: 'Simultáneo',
    desc: 'El evento se difunde a todos los candidatos a la vez. El primero en tomarlo lo reclama.' },
  { value: 'sequential',   icon: 'balance', title: 'Secuencial',
    desc: 'Se asigna a un único operario; si no confirma a tiempo, se reasigna al siguiente.' },
  { value: 'rules',        icon: 'rules',   title: 'Por reglas',
    desc: 'Cada regla decide su propio modo de despacho. Control fino por tipo de evento.' },
]

const DEFAULT = {
  mode: 'simultaneous', sequentialStrategy: 'least_loaded', ackTimeoutSeconds: 30,
  reassignOnTimeout: true, maxConcurrentPerOperator: 5, skillRouting: true,
}

export default function Dispatch() {
  const toast = useToast()
  const [policy, setPolicy] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)

  const load = () => {
    setLoading(true); setError(null)
    getDispatch()
      .then((d) => { setPolicy({ ...DEFAULT, ...(d || {}) }); setDirty(false) })
      .catch(setError)
      .finally(() => setLoading(false))
  }
  useEffect(load, [])

  const set = (k, v) => { setPolicy((p) => ({ ...p, [k]: v })); setDirty(true) }

  const save = async () => {
    setSaving(true)
    try {
      const payload = {
        ...policy,
        ackTimeoutSeconds: Number(policy.ackTimeoutSeconds) || 0,
        maxConcurrentPerOperator: Number(policy.maxConcurrentPerOperator) || 0,
      }
      const r = await putDispatch(payload)
      setPolicy({ ...DEFAULT, ...(r || payload) })
      setDirty(false)
      toast('Política de balanceo guardada')
    } catch (e) { toast(e.message, 'error') }
    finally { setSaving(false) }
  }

  if (loading) return <><PageHead title="Balanceo" /><Loading /></>
  if (error) return <><PageHead title="Balanceo" /><ErrorState error={error} onRetry={load} /></>

  return (
    <div className="anim-rise dispatch-page">
      <PageHead title="Balanceo" subtitle="Cómo se reparten los eventos entre los operarios conectados."
        actions={
          <Button variant="primary" icon={saving ? undefined : 'check'} disabled={saving || !dirty} onClick={save}>
            {saving ? <Spinner size={15} /> : 'Guardar cambios'}
          </Button>
        } />

      <SectionHelp id="dispatch" icon="balance" title="Balanceo de carga">
        Define cómo se reparten los eventos entre los operarios conectados: <b>simultáneo</b> (todos lo ven), <b>secuencial</b> (uno a uno) o <b>por reglas</b>. La estrategia secuencial puede rotar (round-robin) o elegir siempre al operario menos cargado. Cada regla puede sobrescribir esta configuración global.
      </SectionHelp>

      <Panel title={<span className="ptitle"><Icon name="balance" size={16} /> Modo de despacho</span>} subtitle="Determina la estrategia global de reparto.">
        <div className="dispatch-modes">
          {MODES.map((m) => (
            <button key={m.value} type="button"
              className={`dispatch-mode${policy.mode === m.value ? ' is-on' : ''}`}
              onClick={() => set('mode', m.value)}>
              <span className="dispatch-mode__head">
                <span className="ic"><Icon name={m.icon} size={18} /></span>{m.title}
              </span>
              <p className="dispatch-mode__desc">{m.desc}</p>
            </button>
          ))}
        </div>
      </Panel>

      {policy.mode === 'sequential' && (
        <Panel title={<span className="ptitle"><Icon name="sliders" size={16} /> Ajustes del modo secuencial</span>} subtitle="Selección de candidato y reasignación al expirar el tiempo de espera.">
          <div className="dispatch-sub">
            <Field label={<><Icon name="route" size={14} /> Estrategia de selección</>}>
              <Segmented value={policy.sequentialStrategy} onChange={(v) => set('sequentialStrategy', v)}
                options={[{ value: 'round_robin', label: seqStrategyLabel('round_robin') }, { value: 'least_loaded', label: seqStrategyLabel('least_loaded') }]} />
            </Field>
            <div className="setting-row">
              <div className="setting-row__info">
                <b><Icon name="clock" size={14} /> Tiempo de espera de confirmación</b>
                <span>Segundos antes de considerar que el operario no respondió.</span>
              </div>
              <div className="setting-row__ctrl">
                <TextInput type="number" min="0" className="tnum"
                  value={policy.ackTimeoutSeconds} onChange={(e) => set('ackTimeoutSeconds', e.target.value)} />
                <span className="muted">s</span>
              </div>
            </div>
            <div className="setting-row">
              <div className="setting-row__info">
                <b><Icon name="route" size={14} /> Reasignar al expirar</b>
                <span>Pasa al siguiente candidato si no hay confirmación a tiempo.</span>
              </div>
              <div className="setting-row__ctrl">
                <Switch checked={policy.reassignOnTimeout} onChange={(v) => set('reassignOnTimeout', v)} />
              </div>
            </div>
          </div>
        </Panel>
      )}

      <Panel title={<span className="ptitle"><Icon name="gauge" size={16} /> Límites y enrutado</span>} subtitle="Aplican a todos los modos.">
        <div className="dispatch-sub">
          <div className="setting-row">
            <div className="setting-row__info">
              <b><Icon name="gauge" size={14} /> Máximo concurrente por operario</b>
              <span>Candidatos que alcanzan este número quedan excluidos del reparto.</span>
            </div>
            <div className="setting-row__ctrl">
              <TextInput type="number" min="0" className="tnum"
                value={policy.maxConcurrentPerOperator} onChange={(e) => set('maxConcurrentPerOperator', e.target.value)} />
            </div>
          </div>
          <div className="setting-row">
            <div className="setting-row__info">
              <b><Icon name="route" size={14} /> Enrutado por competencia</b>
              <span>Filtra candidatos por competencia según la categoría/tipo del evento.</span>
            </div>
            <div className="setting-row__ctrl">
              <Switch checked={policy.skillRouting} onChange={(v) => set('skillRouting', v)} />
            </div>
          </div>
        </div>
      </Panel>
    </div>
  )
}
