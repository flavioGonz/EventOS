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
// Días para el turno horario (Reguard "Off-duty"): mostrados Lun→Dom, valor 0=Dom.
const SHIFT_DAYS = [
  { v: 1, l: 'L' }, { v: 2, l: 'M' }, { v: 3, l: 'M' }, { v: 4, l: 'J' },
  { v: 5, l: 'V' }, { v: 6, l: 'S' }, { v: 0, l: 'D' },
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

  // ── Turno horario (Reguard "Off-duty") ──
  const sched = form.schedule && form.schedule.mode === 'window' ? form.schedule : null
  const hasShift = !!sched
  const setShift = (on) => setForm((f) => ({ ...f, schedule: on ? { mode: 'window', days: [1, 2, 3, 4, 5], from: '08:00', to: '20:00' } : null }))
  const toggleDay = (v) => setForm((f) => {
    const s = f.schedule && f.schedule.mode === 'window' ? f.schedule : { mode: 'window', days: [], from: '08:00', to: '20:00' }
    const days = s.days.includes(v) ? s.days.filter((d) => d !== v) : [...s.days, v]
    return { ...f, schedule: { ...s, days } }
  })
  const setShiftField = (k, val) => setForm((f) => ({ ...f, schedule: { mode: 'window', days: [1, 2, 3, 4, 5], from: '08:00', to: '20:00', ...(f.schedule || {}), [k]: val } }))

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

  const roleLabel = (ROLES.find((r) => r.value === (form.role || 'agente')) || {}).label?.split(' — ')[0] || 'Agente'
  const shiftText = hasShift
    ? `${(sched.days || []).length ? SHIFT_DAYS.filter((d) => sched.days.includes(d.v)).map((d) => d.l).join(' ') : 'Todos'} · ${sched.from || '08:00'}–${sched.to || '20:00'}`
    : 'Siempre disponible'

  return (
    <EditPage title={isNew ? 'Nuevo operario' : 'Editar operario'}
      subtitle="Operador, su rol de acceso y sus competencias para el enrutado." onCancel={back} onSave={save} saving={saving}>
     <div className="edit-2col">
      <div className="edit-2col__form form-grid">
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

        <Field label={<><Icon name="clock" size={14} /> Turno horario</>}
          hint="Si está activo y el balanceo respeta turnos (Admin › Balanceo), fuera de este horario no se le asignan eventos automáticamente. Igual puede tomarlos a mano.">
          <Switch checked={hasShift} onChange={setShift} label={hasShift ? 'Con turno horario' : 'Siempre disponible'} />
        </Field>
        {hasShift && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {SHIFT_DAYS.map((d) => {
                const on = sched.days.includes(d.v)
                return (
                  <button key={d.v} type="button" onClick={() => toggleDay(d.v)}
                    style={{ minWidth: 36, padding: '7px 0', borderRadius: 8, cursor: 'pointer',
                      border: '1px solid var(--border, #3a3a3a)', fontWeight: 600,
                      background: on ? 'var(--accent, #3b82f6)' : 'transparent',
                      color: on ? '#fff' : 'inherit' }}>{d.l}</button>
                )
              })}
            </div>
            <div style={{ display: 'flex', gap: 16 }}>
              <Field label="Desde">
                <TextInput type="time" value={sched.from || '08:00'} onChange={(e) => setShiftField('from', e.target.value)} />
              </Field>
              <Field label="Hasta">
                <TextInput type="time" value={sched.to || '20:00'} onChange={(e) => setShiftField('to', e.target.value)} />
              </Field>
            </div>
            <span className="muted" style={{ fontSize: 12 }}>La ventana puede cruzar medianoche (ej. 20:00 → 08:00). Sin días marcados = todos los días.</span>
          </div>
        )}
      </div>

      <aside className="edit-aside">
        <div className="edit-aside__card">
          <div className="edit-aside__hd">
            <span className="edit-aside__ic"><Icon name="users" size={20} /></span>
            <div><small>Resumen</small><b>{form.name?.trim() || 'Nuevo operario'}</b></div>
          </div>
          <div className="edit-aside__rows">
            <div className="edit-aside__row"><span><Icon name="shield" size={13} /> Rol</span><span className="edit-aside__v">{roleLabel}</span></div>
            <div className="edit-aside__row"><span><Icon name="shield" size={13} /> PIN</span><span className="edit-aside__v">{pin ? 'Nuevo' : removePin ? 'Se quita' : hasPin ? 'Configurado' : 'Sin PIN'}</span></div>
            <div className="edit-aside__row"><span><Icon name="tag" size={13} /> Competencias</span><span className="edit-aside__v">{form.skills?.length || 0}</span></div>
            <div className="edit-aside__row"><span><Icon name="online" size={13} /> Estado</span><span className="edit-aside__v">{form.active ? 'Activo' : 'Inactivo'}</span></div>
            <div className="edit-aside__row"><span><Icon name="clock" size={13} /> Turno</span><span className="edit-aside__v">{shiftText}</span></div>
          </div>
        </div>
        <div className="edit-aside__card">
          <div className="edit-aside__hd">
            <span className="edit-aside__ic"><Icon name="info" size={20} /></span>
            <div><small>Cómo se usa</small><b>Enrutado por operario</b></div>
          </div>
          <ul className="edit-aside__tips">
            <li><b><Icon name="check" size={12} /></b><span>El <b>rol</b> define qué ve al iniciar sesión: agente (consola), supervisor (+panel y videowall) o admin (total).</span></li>
            <li><b><Icon name="check" size={12} /></b><span>Las <b>competencias</b> deciden qué eventos se le enrutan cuando el balanceo respeta habilidades.</span></li>
            <li><b><Icon name="check" size={12} /></b><span>Con <b>turno horario</b>, fuera de su ventana no recibe eventos automáticos — pero puede tomarlos a mano.</span></li>
          </ul>
        </div>
      </aside>
     </div>
    </EditPage>
  )
}
