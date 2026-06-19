// Operario — página de edición dedicada.
import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Field, TextInput, Select, Switch, Icon, Button } from '../ui/primitives.jsx'
import { collectionApi, EVENT_CATEGORIES } from '../lib/adminApi.js'
import { categoryLabel } from '../lib/labels.js'
import { EditPage, Loading, useToast, TagInput } from './_shared.jsx'

const EMPTY = { name: '', skills: [], active: true, role: 'agente' }
const ROLES = [
  { value: 'agente', label: 'Agente — solo consola' },
  { value: 'supervisor', label: 'Supervisor — consola + panel + videowall' },
  { value: 'admin', label: 'Admin — acceso total' },
]

export default function OperatorEdit() {
  const { id } = useParams()
  const isNew = !id || id === 'new'
  const navigate = useNavigate()
  const toast = useToast()
  const [form, setForm] = useState(EMPTY)
  const [loading, setLoading] = useState(!isNew)
  const [saving, setSaving] = useState(false)
  const [pin, setPin] = useState('')        // PIN nuevo (write-only)
  const [removePin, setRemovePin] = useState(false)
  const hasPin = !!form.pinHash

  useEffect(() => {
    if (isNew) return
    let alive = true
    collectionApi('operators').get(id)
      .then((d) => { if (alive) setForm({ ...EMPTY, ...d }) })
      .catch((e) => toast(e.message || 'No se pudo cargar', 'error'))
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [id, isNew]) // eslint-disable-line react-hooks/exhaustive-deps

  const back = () => navigate('/admin/operators')
  const save = async () => {
    if (!form.name.trim()) { toast('El nombre es obligatorio', 'error'); return }
    if (pin && pin.length < 4) { toast('El PIN debe tener al menos 4 dígitos', 'error'); return }
    setSaving(true)
    // El payload no lleva pinHash; el server hashea `pin` si viene. pin:'' lo borra.
    const { pinHash, ...rest } = form
    const payload = { ...rest, role: form.role || 'agente' }
    if (pin) payload.pin = pin
    else if (removePin) payload.pin = ''
    try {
      if (isNew) await collectionApi('operators').create(payload)
      else await collectionApi('operators').update(id, payload)
      toast('Operario guardado'); back()
    } catch (e) { toast(e.message, 'error'); setSaving(false) }
  }

  if (loading) return <Loading label="Cargando operario…" />

  return (
    <EditPage title={isNew ? 'Nuevo operario' : 'Editar operario'}
      subtitle="Operador, su rol de acceso y sus competencias para el enrutado." onCancel={back} onSave={save} saving={saving}>
      <div className="form-grid" style={{ maxWidth: 560 }}>
        <Field label={<><Icon name="users" size={14} /> Nombre</>}>
          <TextInput autoFocus value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="Ana" />
        </Field>
        <Field label={<><Icon name="shield" size={14} /> Rol de acceso</>}
          hint="Define qué puede ver al iniciar sesión (escalonado).">
          <Select value={form.role || 'agente'} onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}>
            {ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </Select>
        </Field>
        <Field label={<><Icon name="shield" size={14} /> PIN de acceso</>}
          hint={hasPin ? 'Este operario ya tiene PIN. Escribe uno nuevo para cambiarlo, o quítalo.' : 'Opcional. 4-8 dígitos que se piden al iniciar sesión.'}>
          <TextInput type="password" inputMode="numeric" value={pin} maxLength={8}
            onChange={(e) => { setPin(e.target.value.replace(/\D/g, '')); setRemovePin(false) }}
            placeholder={hasPin ? '•••• (sin cambios)' : 'Sin PIN'} autoComplete="new-password" />
        </Field>
        {hasPin && !pin && (
          <Button variant={removePin ? 'danger' : 'ghost'} size="sm" icon="trash" onClick={() => setRemovePin((v) => !v)}>
            {removePin ? 'Se quitará el PIN al guardar' : 'Quitar PIN'}
          </Button>
        )}
        <Field label={<><Icon name="tag" size={14} /> Competencias</>} hint={`Sugeridas: ${EVENT_CATEGORIES.map(categoryLabel).join(', ')}. Pulsa Enter para añadir.`}>
          <TagInput value={form.skills} onChange={(skills) => setForm((f) => ({ ...f, skills }))} placeholder="video, accesos…" />
        </Field>
        <Field label={<><Icon name="online" size={14} /> Estado</>}>
          <Switch checked={form.active} onChange={(active) => setForm((f) => ({ ...f, active }))} label={form.active ? 'Activo' : 'Inactivo'} />
        </Field>
      </div>
    </EditPage>
  )
}
