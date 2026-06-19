// Grupo de operarios — página de edición dedicada.
import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Field, TextInput, Icon } from '../ui/primitives.jsx'
import { collectionApi, unwrap, EVENT_CATEGORIES } from '../lib/adminApi.js'
import { categoryLabel } from '../lib/labels.js'
import { EditPage, Loading, useToast, ChipMulti, TagInput } from './_shared.jsx'

const EMPTY = { name: '', operatorIds: [], skills: [] }

export default function GroupEdit() {
  const { id } = useParams()
  const isNew = !id || id === 'new'
  const navigate = useNavigate()
  const toast = useToast()
  const [form, setForm] = useState(EMPTY)
  const [operators, setOperators] = useState([])
  const [loading, setLoading] = useState(!isNew)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    collectionApi('operators').list().then((d) => setOperators(unwrap(d, 'operators'))).catch(() => {})
  }, [])
  useEffect(() => {
    if (isNew) return
    let alive = true
    collectionApi('groups').get(id)
      .then((d) => { if (alive) setForm({ ...EMPTY, ...d }) })
      .catch((e) => toast(e.message || 'No se pudo cargar', 'error'))
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [id, isNew]) // eslint-disable-line react-hooks/exhaustive-deps

  const back = () => navigate('/admin/groups')
  const save = async () => {
    if (!form.name.trim()) { toast('El nombre es obligatorio', 'error'); return }
    setSaving(true)
    try {
      if (isNew) await collectionApi('groups').create(form)
      else await collectionApi('groups').update(id, form)
      toast('Grupo guardado'); back()
    } catch (e) { toast(e.message, 'error'); setSaving(false) }
  }

  if (loading) return <Loading label="Cargando grupo…" />

  return (
    <EditPage title={isNew ? 'Nuevo grupo' : 'Editar grupo'}
      subtitle="Conjunto de operarios para enrutar reglas y transferir eventos en vivo." onCancel={back} onSave={save} saving={saving}>
      <div className="form-grid" style={{ maxWidth: 640 }}>
        <Field label={<><Icon name="users" size={14} /> Nombre del grupo</>}>
          <TextInput autoFocus value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="Turno Noche" />
        </Field>
        <Field label={<><Icon name="users" size={14} /> Miembros</>} hint="Operarios que pertenecen al grupo.">
          <ChipMulti value={form.operatorIds}
            options={operators.map((o) => ({ value: o.id, label: o.name }))}
            onChange={(v) => setForm((f) => ({ ...f, operatorIds: v }))} />
        </Field>
        <Field label={<><Icon name="tag" size={14} /> Competencias del grupo</>} hint={`Opcional. Filtra a los miembros por competencia. Sugeridas: ${EVENT_CATEGORIES.map(categoryLabel).join(', ')}.`}>
          <TagInput value={form.skills} onChange={(skills) => setForm((f) => ({ ...f, skills }))} placeholder="intrusion, video…" />
        </Field>
      </div>
    </EditPage>
  )
}
