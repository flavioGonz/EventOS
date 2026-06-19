// Procedimiento — página de edición dedicada (editor de pasos ordenados).
import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Button, IconButton, Field, TextInput, Icon } from '../ui/primitives.jsx'
import { collectionApi } from '../lib/adminApi.js'
import { EditPage, Loading, useToast } from './_shared.jsx'

const EMPTY = { name: '', slaSeconds: 60, steps: [''] }

export default function ProcedureEdit() {
  const { id } = useParams()
  const isNew = !id || id === 'new'
  const navigate = useNavigate()
  const toast = useToast()
  const [form, setForm] = useState({ ...EMPTY, steps: [''] })
  const [loading, setLoading] = useState(!isNew)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (isNew) return
    let alive = true
    collectionApi('procedures').get(id)
      .then((d) => { if (alive) setForm({ ...EMPTY, ...d, steps: d.steps?.length ? [...d.steps] : [''] }) })
      .catch((e) => toast(e.message || 'No se pudo cargar', 'error'))
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [id, isNew]) // eslint-disable-line react-hooks/exhaustive-deps

  const setStep = (i, v) => setForm((f) => { const s = [...f.steps]; s[i] = v; return { ...f, steps: s } })
  const addStep = () => setForm((f) => ({ ...f, steps: [...f.steps, ''] }))
  const removeStep = (i) => setForm((f) => ({ ...f, steps: f.steps.filter((_, j) => j !== i) }))
  const moveStep = (i, dir) => setForm((f) => {
    const j = i + dir
    if (j < 0 || j >= f.steps.length) return f
    const s = [...f.steps];[s[i], s[j]] = [s[j], s[i]]; return { ...f, steps: s }
  })

  const back = () => navigate('/admin/procedures')
  const save = async () => {
    if (!form.name.trim()) { toast('El nombre es obligatorio', 'error'); return }
    setSaving(true)
    const payload = { ...form, slaSeconds: Number(form.slaSeconds) || 0, steps: form.steps.map((s) => s.trim()).filter(Boolean) }
    try {
      if (isNew) await collectionApi('procedures').create(payload)
      else await collectionApi('procedures').update(id, payload)
      toast('Procedimiento guardado'); back()
    } catch (e) { toast(e.message, 'error'); setSaving(false) }
  }

  if (loading) return <Loading label="Cargando procedimiento…" />

  return (
    <EditPage title={isNew ? 'Nuevo procedimiento' : 'Editar procedimiento'}
      subtitle="Protocolo paso a paso que se muestra al operario al atender un evento." onCancel={back} onSave={save} saving={saving}>
      <div style={{ maxWidth: 720 }}>
        <div className="form-grid form-grid--2">
          <Field label={<><Icon name="procedure" size={14} /> Nombre</>}>
            <TextInput autoFocus value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="Intrusión confirmada" />
          </Field>
          <Field label={<><Icon name="clock" size={14} /> SLA (segundos)</>} hint="Tiempo objetivo de resolución.">
            <TextInput type="number" min="0" value={form.slaSeconds} onChange={(e) => setForm((f) => ({ ...f, slaSeconds: e.target.value }))} />
          </Field>
        </div>

        <p className="section-label u-mt-18"><Icon name="rules" size={14} /> Pasos del protocolo</p>
        <div className="steps">
          {form.steps.map((step, i) => (
            <div className="step-row" key={i}>
              <span className="step-row__num">{i + 1}</span>
              <TextInput value={step} onChange={(e) => setStep(i, e.target.value)} placeholder={`Paso ${i + 1}…`} aria-label={`Paso ${i + 1}`} />
              <span className="step-reorder">
                <IconButton icon="chevron" size="sm" label="Subir" onClick={() => moveStep(i, -1)} disabled={i === 0} className="icon-rot-up" />
                <IconButton icon="chevron" size="sm" label="Bajar" onClick={() => moveStep(i, 1)} disabled={i === form.steps.length - 1} className="icon-rot-down" />
              </span>
              <IconButton icon="trash" size="sm" label="Quitar paso" onClick={() => removeStep(i)} disabled={form.steps.length === 1} />
            </div>
          ))}
        </div>
        <Button size="sm" icon="plus" variant="secondary" onClick={addStep} className="u-mt-12">Añadir paso</Button>
      </div>
    </EditPage>
  )
}
