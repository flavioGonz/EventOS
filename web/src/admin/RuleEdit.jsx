// Regla — página de edición dedicada (matching + acciones + modo de despacho).
import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Field, TextInput, Select, Switch, Icon } from '../ui/primitives.jsx'
import {
  collectionApi, unwrap, EVENT_TYPES, EVENT_CATEGORIES, TARGETS,
} from '../lib/adminApi.js'
import {
  eventTypeLabel, categoryLabel, dispatchModeLabel, priorityLabel, EVENT_TYPE_ICON, seqStrategyLabel,
  targetLabel, TARGET_ICON,
} from '../lib/labels.js'
import { EditPage, PageHead, Loading, useToast, ChipMulti, TagInput } from './_shared.jsx'
import { Wizard } from './Wizard.jsx'
import { EventTypeGrid } from './EventTypeGrid.jsx'

const WSTEPS = [
  { key: 'cond', label: 'Condición' },
  { key: 'act', label: 'Acción' },
  { key: 'rev', label: 'Revisar' },
]
// Objetivo (IA de cámara) como botones con explicación.
const TARGET_CARDS = [
  ['human', 'Persona', 'user', 'La cámara clasificó una persona'],
  ['vehicle', 'Vehículo', 'car', 'La cámara clasificó un vehículo'],
  ['none', 'Sin objetivo', 'filter', 'No clasificó nada → probable falsa alarma'],
]

const RULE_MODE_CARDS = [
  { value: 'simultaneous', icon: 'bell', title: 'Simultáneo',
    desc: 'Se difunde a todos los candidatos a la vez. El primero que la toma la reclama. Máxima velocidad de respuesta.' },
  { value: 'sequential', icon: 'route', title: 'Secuencial',
    desc: 'Se asigna a UN operario; si no confirma a tiempo, pasa al siguiente. Reparte la carga y evita pisones.' },
  { value: 'rules-inherit', icon: 'balance', title: 'Heredar global',
    desc: 'Usa el modo definido en Balanceo. Útil si esta regla no necesita un trato especial.' },
]

function dispToForm(d = {}) {
  return {
    sequentialStrategy: d?.sequentialStrategy || '',
    ackTimeoutSeconds: d?.ackTimeoutSeconds ?? '',
    reassignOnTimeout: d?.reassignOnTimeout === true ? 'yes' : d?.reassignOnTimeout === false ? 'no' : '',
    maxConcurrentPerOperator: d?.maxConcurrentPerOperator ?? '',
    skillRouting: d?.skillRouting === true ? 'yes' : d?.skillRouting === false ? 'no' : '',
  }
}

function emptyRule(order) {
  return {
    name: '', enabled: true, order: order ?? 10,
    match: { type: [], category: [], target: [], deviceId: [], siteId: [] },
    actions: {
      setPriority: null, procedureId: '', dispatchMode: 'simultaneous',
      skills: [], operatorIds: [], groupIds: [], discard: false, dispatch: dispToForm(),
    },
  }
}

export default function RuleEdit() {
  const { id } = useParams()
  const isNew = !id || id === 'new'
  const navigate = useNavigate()
  const toast = useToast()
  const [procedures, setProcedures] = useState([])
  const [devices, setDevices] = useState([])
  const [sites, setSites] = useState([])
  const [operators, setOperators] = useState([])
  const [groups, setGroups] = useState([])
  const [form, setForm] = useState(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [step, setStep] = useState(0)

  useEffect(() => {
    collectionApi('procedures').list().then((d) => setProcedures(unwrap(d, 'procedures'))).catch(() => {})
    collectionApi('devices').list().then((d) => setDevices(unwrap(d, 'devices'))).catch(() => {})
    collectionApi('sites').list().then((d) => setSites(unwrap(d, 'sites'))).catch(() => {})
    collectionApi('operators').list().then((d) => setOperators(unwrap(d, 'operators'))).catch(() => {})
    collectionApi('groups').list().then((d) => setGroups(unwrap(d, 'groups'))).catch(() => {})
  }, [])

  useEffect(() => {
    let alive = true
    if (isNew) {
      // Calcula el orden por defecto a partir de las reglas existentes.
      collectionApi('rules').list()
        .then((d) => { const arr = unwrap(d, 'rules'); return arr.length ? Math.max(...arr.map((x) => x.order || 0)) + 10 : 10 })
        .catch(() => 10)
        .then((order) => { if (alive) { setForm(emptyRule(order)); setLoading(false) } })
      return () => { alive = false }
    }
    collectionApi('rules').get(id)
      .then((r) => {
        const base = emptyRule(r.order)
        if (alive) setForm({
          ...base, ...r,
          match: { ...base.match, ...(r.match || {}) },
          actions: { ...base.actions, ...(r.actions || {}), dispatch: dispToForm(r.actions?.dispatch) },
        })
      })
      .catch((e) => toast(e.message || 'No se pudo cargar', 'error'))
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [id, isNew]) // eslint-disable-line react-hooks/exhaustive-deps

  const setMatch = (k, v) => setForm((f) => ({ ...f, match: { ...f.match, [k]: v } }))
  const setAct = (k, v) => setForm((f) => ({ ...f, actions: { ...f.actions, [k]: v } }))
  const setDisp = (k, v) => setForm((f) => ({ ...f, actions: { ...f.actions, dispatch: { ...f.actions.dispatch, [k]: v } } }))

  const back = () => navigate('/admin/rules')
  const save = async () => {
    if (!form.name.trim()) { toast('El nombre es obligatorio', 'error'); return }
    setSaving(true)
    const d = form.actions.dispatch || {}
    const dispatch = {}
    if (d.sequentialStrategy) dispatch.sequentialStrategy = d.sequentialStrategy
    if (d.ackTimeoutSeconds !== '' && d.ackTimeoutSeconds != null) dispatch.ackTimeoutSeconds = Number(d.ackTimeoutSeconds)
    if (d.reassignOnTimeout === 'yes' || d.reassignOnTimeout === 'no') dispatch.reassignOnTimeout = d.reassignOnTimeout === 'yes'
    if (d.maxConcurrentPerOperator !== '' && d.maxConcurrentPerOperator != null) dispatch.maxConcurrentPerOperator = Number(d.maxConcurrentPerOperator)
    if (d.skillRouting === 'yes' || d.skillRouting === 'no') dispatch.skillRouting = d.skillRouting === 'yes'
    const payload = {
      ...form,
      order: Number(form.order) || 0,
      actions: {
        ...form.actions,
        setPriority: form.actions.setPriority ? Number(form.actions.setPriority) : null,
        procedureId: form.actions.procedureId || null,
        dispatch,
      },
    }
    try {
      if (isNew) await collectionApi('rules').create(payload)
      else await collectionApi('rules').update(id, payload)
      toast('Regla guardada'); back()
    } catch (e) { toast(e.message, 'error'); setSaving(false) }
  }

  if (loading || !form) return <Loading label="Cargando regla…" />

  const toggleIn = (arr, v) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v])
  const canNext = step === 0 ? !!form.name.trim() : true
  const procName = (procedures.find((p) => p.id === form.actions.procedureId) || {}).name
  const modeTitle = (RULE_MODE_CARDS.find((m) => m.value === form.actions.dispatchMode) || {}).title

  return (
    <div className="anim-rise">
      <PageHead title={isNew ? 'Nueva regla — asistente' : `Editar regla · ${form.name || ''}`}
        subtitle="Definí en 3 pasos cuándo se dispara y qué hace EventOS." />
      <div className="wizpage wizpage--wide">
        <Wizard steps={WSTEPS} step={step} onStep={setStep} jumpable={!isNew}
          onCancel={back} onFinish={save} canNext={canNext} finishing={saving}
          finishLabel={isNew ? 'Crear regla' : 'Guardar regla'}>

          {step === 0 && (
            <>
              <Field2 label={<><Icon name="rules" size={14} /> Nombre de la regla</>}>
                <TextInput autoFocus value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="Intrusiones críticas con persona" />
              </Field2>
              <p className="wiz__q u-mt-16">1 · ¿Qué eventos casa esta regla?</p>
              <p className="help-block">Elegí uno o más tipos. Si no marcás ninguno, casa <b>cualquier</b> evento.</p>
              <EventTypeGrid size="sm" types={EVENT_TYPES} isOn={(v) => form.match.type.includes(v)}
                onToggle={(v) => setMatch('type', toggleIn(form.match.type, v))} />

              <p className="section-label u-mt-16"><Icon name="user" size={14} /> Objetivo de la cámara (IA) <span className="muted">· opcional</span></p>
              <p className="help-block">La cámara clasifica qué generó el evento. Filtrar por persona/vehículo recorta falsas alarmas.</p>
              <div className="etgrid etgrid--sm">
                {TARGET_CARDS.map(([val, lbl, icon, desc]) => {
                  const on = form.match.target.includes(val)
                  return (
                    <button type="button" key={val} className={`etcard${on ? ' is-on' : ''}`} onClick={() => setMatch('target', toggleIn(form.match.target, val))}>
                      <span className="etcard__ic"><Icon name={icon} size={22} /></span>
                      <span className="etcard__lbl">{lbl}</span>
                      <span className="etcard__desc">{desc}</span>
                      {on && <span className="etcard__check"><Icon name="check" size={13} /></span>}
                    </button>
                  )
                })}
              </div>

              <details className="wiz__more u-mt-14">
                <summary>Acotar a un dispositivo o sitio (opcional)</summary>
                <div className="form-grid form-grid--2 u-mt-12">
                  <Field2 label={<><Icon name="device" size={14} /> Dispositivo</>}>
                    <Select value={form.match.deviceId[0] || ''} onChange={(e) => setMatch('deviceId', e.target.value ? [e.target.value] : [])}>
                      <option value="">— Cualquiera —</option>
                      {devices.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                    </Select>
                  </Field2>
                  <Field2 label={<><Icon name="site" size={14} /> Sitio</>}>
                    <Select value={form.match.siteId[0] || ''} onChange={(e) => setMatch('siteId', e.target.value ? [e.target.value] : [])}>
                      <option value="">— Cualquiera —</option>
                      {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </Select>
                  </Field2>
                </div>
              </details>
            </>
          )}

          {step === 1 && (
            <>
              <p className="wiz__q">2 · ¿Qué hace EventOS con estos eventos?</p>
              <div className="form-grid form-grid--2">
                <Field2 label={<><Icon name="flag" size={14} /> Prioridad</>} hint="Con qué urgencia llega al operador.">
                  <Select value={form.actions.setPriority ?? ''} onChange={(e) => setAct('setPriority', e.target.value || null)}>
                    <option value="">— No cambiar —</option>
                    {[1, 2, 3, 4, 5].map((p) => <option key={p} value={p}>{`P${p} · ${priorityLabel(p)}`}</option>)}
                  </Select>
                </Field2>
                <Field2 label={<><Icon name="procedure" size={14} /> Procedimiento</>} hint="Pasos que verá el operador.">
                  <Select value={form.actions.procedureId || ''} onChange={(e) => setAct('procedureId', e.target.value)}>
                    <option value="">— Ninguno —</option>
                    {procedures.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </Select>
                </Field2>
              </div>
              <Field2 label={<><Icon name="filter" size={14} /> Descartar como falsa alarma</>} hint="No alerta al operador; solo queda en analítica. Útil con Objetivo = «Sin objetivo»." className="u-mt-12">
                <Switch checked={!!form.actions.discard} onChange={(v) => setAct('discard', v)} label={form.actions.discard ? 'Se descarta' : 'No'} />
              </Field2>

              <p className="section-label u-mt-16"><Icon name="balance" size={14} /> Cómo se reparte entre operarios</p>
              <div className="dispatch-modes dispatch-modes--stack">
                {RULE_MODE_CARDS.map((m) => (
                  <button key={m.value} type="button"
                    className={`dispatch-mode${form.actions.dispatchMode === m.value ? ' is-on' : ''}`}
                    onClick={() => setAct('dispatchMode', m.value)}>
                    <span className="dispatch-mode__head"><span className="ic"><Icon name={m.icon} size={18} /></span>{m.title}</span>
                    <p className="dispatch-mode__desc">{m.desc}</p>
                  </button>
                ))}
              </div>

              {form.actions.dispatchMode === 'sequential' && (
                <div className="rule-disp-ov">
                  <p className="section-label"><Icon name="sliders" size={14} /> Ajustes de reparto · esta regla</p>
                  <div className="form-grid form-grid--2">
                    <Field2 label={<><Icon name="route" size={14} /> Estrategia</>}>
                      <Select value={form.actions.dispatch.sequentialStrategy} onChange={(e) => setDisp('sequentialStrategy', e.target.value)}>
                        <option value="">— Global —</option>
                        <option value="least_loaded">{seqStrategyLabel('least_loaded')}</option>
                        <option value="round_robin">{seqStrategyLabel('round_robin')}</option>
                      </Select>
                    </Field2>
                    <Field2 label={<><Icon name="clock" size={14} /> ACK timeout (s)</>}>
                      <TextInput type="number" min="0" placeholder="Global" className="tnum"
                        value={form.actions.dispatch.ackTimeoutSeconds} onChange={(e) => setDisp('ackTimeoutSeconds', e.target.value)} />
                    </Field2>
                  </div>
                </div>
              )}

              <details className="wiz__more u-mt-14">
                <summary>Enrutado avanzado (competencias, grupos, operarios)</summary>
                <Field2 label={<><Icon name="tag" size={14} /> Competencias requeridas</>} hint="Solo operarios con estas competencias son candidatos." className="u-mt-12">
                  <TagInput value={form.actions.skills} onChange={(v) => setAct('skills', v)} placeholder="intrusion, video…" />
                </Field2>
                <Field2 label={<><Icon name="shieldcheck" size={14} /> Grupos destinatarios</>} hint="Se enruta a los miembros de estos grupos." className="u-mt-12">
                  <ChipMulti value={form.actions.groupIds} options={groups.map((g) => ({ value: g.id, label: g.name }))} onChange={(v) => setAct('groupIds', v)} />
                </Field2>
                <Field2 label={<><Icon name="users" size={14} /> Operarios fijos</>} hint="Si se fijan, solo estos reciben el evento." className="u-mt-12">
                  <ChipMulti value={form.actions.operatorIds} options={operators.map((o) => ({ value: o.id, label: o.name }))} onChange={(v) => setAct('operatorIds', v)} />
                </Field2>
              </details>
            </>
          )}

          {step === 2 && (
            <>
              <p className="wiz__q">3 · Revisá y guardá</p>
              <div className="form-grid form-grid--2">
                <Field2 label={<><Icon name="hash" size={14} /> Orden de evaluación</>} hint="Menor = se evalúa antes.">
                  <TextInput type="number" value={form.order} onChange={(e) => setForm((f) => ({ ...f, order: e.target.value }))} className="tnum" />
                </Field2>
                <Field2 label={<><Icon name="online" size={14} /> Estado</>}>
                  <Switch checked={form.enabled} onChange={(enabled) => setForm((f) => ({ ...f, enabled }))} label={form.enabled ? 'Activa' : 'Desactivada'} />
                </Field2>
              </div>
              <div className="wiz__review u-mt-12">
                <Row k="Nombre" v={form.name || '—'} />
                <Row k="Casa eventos" v={form.match.type.length ? form.match.type.map(eventTypeLabel).join(', ') : 'Cualquiera'} />
                <Row k="Objetivo" v={form.match.target.length ? form.match.target.map(targetLabel).join(', ') : 'Cualquiera'} />
                <Row k="Prioridad" v={form.actions.setPriority ? `P${form.actions.setPriority}` : 'Sin cambio'} />
                <Row k="Procedimiento" v={procName || 'Ninguno'} />
                <Row k="Falsa alarma" v={form.actions.discard ? 'Se descarta' : 'No'} />
                <Row k="Despacho" v={modeTitle || '—'} />
                {form.actions.groupIds.length > 0 && <Row k="Grupos" v={`${form.actions.groupIds.length}`} />}
              </div>
            </>
          )}
        </Wizard>
      </div>
    </div>
  )
}

function Row({ k, v }) {
  return <div className="wiz__rrow"><span className="wiz__rk">{k}</span><span className="wiz__rv">{v}</span></div>
}

// Alias local (legibilidad del bloque de formulario).
function Field2(props) { return <Field {...props} /> }
