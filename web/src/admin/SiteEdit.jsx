// Sitio — página de edición dedicada (cliente + lista de llamada + parlantes SIP + mapa).
import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Button, IconButton, Field, TextInput, Textarea, Icon, Glass, Spinner } from '../ui/primitives.jsx'
import { collectionApi } from '../lib/adminApi.js'
import { PageHead, Loading, useToast } from './_shared.jsx'
import SiteMap from '../components/SiteMap.jsx'
import SiteDevices from './SiteDevices.jsx'
import EvidenceSearch from './EvidenceSearch.jsx'
import SiteHealth from './SiteHealth.jsx'

const EMPTY = {
  name: '', address: '', account: '', emergencyNumber: '', protocol: '', notes: '',
  contacts: [], speakers: [], lat: '', lng: '',
}
const EMPTY_CONTACT = { name: '', role: '', phone: '' }
const EMPTY_SPEAKER = { name: '', zone: '', sip: '', phone: '' }

function normalizeContacts(contacts) {
  if (!Array.isArray(contacts)) return []
  return contacts.slice().sort((a, b) => (a.order ?? 99) - (b.order ?? 99))
    .map((c) => ({ name: c.name || '', role: c.role || '', phone: c.phone || '' }))
}
function normalizeSpeakers(speakers) {
  if (!Array.isArray(speakers)) return []
  return speakers.slice().sort((a, b) => (a.order ?? 99) - (b.order ?? 99))
    .map((s) => ({ name: s.name || '', zone: s.zone || '', sip: s.sip || '', phone: s.phone || '' }))
}

export default function SiteEdit() {
  const { id } = useParams()
  const isNew = !id || id === 'new'
  const navigate = useNavigate()
  const toast = useToast()
  const [form, setForm] = useState(EMPTY)
  const [loading, setLoading] = useState(!isNew)
  const [saving, setSaving] = useState(false)
  const [tab, setTab] = useState('ficha')

  useEffect(() => {
    if (isNew) return
    let alive = true
    collectionApi('sites').get(id)
      .then((s) => { if (alive) setForm({ ...EMPTY, ...s, contacts: normalizeContacts(s.contacts), speakers: normalizeSpeakers(s.speakers), lat: s.lat ?? '', lng: s.lng ?? '' }) })
      .catch((e) => toast(e.message || 'No se pudo cargar', 'error'))
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [id, isNew]) // eslint-disable-line react-hooks/exhaustive-deps

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))

  const addContact = () => setForm((f) => ({ ...f, contacts: [...(f.contacts || []), { ...EMPTY_CONTACT }] }))
  const removeContact = (i) => setForm((f) => ({ ...f, contacts: f.contacts.filter((_, idx) => idx !== i) }))
  const setContact = (i, k) => (e) =>
    setForm((f) => ({ ...f, contacts: f.contacts.map((c, idx) => (idx === i ? { ...c, [k]: e.target.value } : c)) }))
  const moveContact = (i, dir) => setForm((f) => {
    const next = f.contacts.slice(); const j = i + dir
    if (j < 0 || j >= next.length) return f
    ;[next[i], next[j]] = [next[j], next[i]]; return { ...f, contacts: next }
  })

  const addSpeaker = () => setForm((f) => ({ ...f, speakers: [...(f.speakers || []), { ...EMPTY_SPEAKER }] }))
  const removeSpeaker = (i) => setForm((f) => ({ ...f, speakers: f.speakers.filter((_, idx) => idx !== i) }))
  const setSpeaker = (i, k) => (e) =>
    setForm((f) => ({ ...f, speakers: f.speakers.map((s, idx) => (idx === i ? { ...s, [k]: e.target.value } : s)) }))

  const setCoords = (lat, lng) => setForm((f) => ({ ...f, lat, lng }))

  const back = () => navigate('/admin/sites')
  const save = async () => {
    if (!form.name.trim()) { toast('El nombre es obligatorio', 'error'); return }
    setSaving(true)
    const contacts = (form.contacts || [])
      .filter((c) => (c.name || '').trim() || (c.phone || '').trim())
      .map((c, i) => ({ name: (c.name || '').trim(), role: (c.role || '').trim(), phone: (c.phone || '').trim(), order: i + 1 }))
    const speakers = (form.speakers || [])
      .filter((s) => (s.name || '').trim() || (s.sip || '').trim() || (s.phone || '').trim())
      .map((s, i) => ({ name: (s.name || '').trim(), zone: (s.zone || '').trim(), sip: (s.sip || '').trim(), phone: (s.phone || '').trim(), order: i + 1 }))
    const lat = form.lat === '' || form.lat == null ? null : Number(form.lat)
    const lng = form.lng === '' || form.lng == null ? null : Number(form.lng)
    const payload = {
      ...form,
      address: form.address.trim(), account: form.account.trim(),
      emergencyNumber: form.emergencyNumber.trim(), protocol: form.protocol.trim(),
      contacts, speakers,
      lat: Number.isFinite(lat) ? lat : null, lng: Number.isFinite(lng) ? lng : null,
    }
    try {
      if (isNew) await collectionApi('sites').create(payload)
      else await collectionApi('sites').update(id, payload)
      toast('Sitio guardado'); back()
    } catch (e) { toast(e.message, 'error'); setSaving(false) }
  }

  if (loading) return <Loading label="Cargando sitio…" />

  const latNum = form.lat === '' ? NaN : Number(form.lat)
  const lngNum = form.lng === '' ? NaN : Number(form.lng)

  return (
    <div className="anim-rise">
      <PageHead title={isNew ? 'Nuevo sitio' : (form.name || 'Editar sitio')}
        subtitle="Cliente y ubicación: datos, lista de llamada, parlantes SIP y mapa."
        actions={tab === 'ficha' ? (
          <>
            <Button variant="ghost" onClick={back}>Cancelar</Button>
            <Button variant="primary" icon={saving ? undefined : 'check'} disabled={saving} onClick={save}>
              {saving ? <Spinner size={15} /> : 'Guardar'}
            </Button>
          </>
        ) : <Button variant="ghost" icon="chevron" onClick={back}>Volver</Button>} />

      {!isNew && (
        <div className="subtabs">
          <button type="button" className={`subtab${tab === 'ficha' ? ' is-on' : ''}`} onClick={() => setTab('ficha')}>
            <Icon name="building" size={15} /> Ficha
          </button>
          <button type="button" className={`subtab${tab === 'dispositivos' ? ' is-on' : ''}`} onClick={() => setTab('dispositivos')}>
            <Icon name="camera" size={15} /> Dispositivos
          </button>
          <button type="button" className={`subtab${tab === 'salud' ? ' is-on' : ''}`} onClick={() => setTab('salud')}>
            <Icon name="gauge" size={15} /> Salud
          </button>
          <button type="button" className={`subtab${tab === 'busqueda' ? ' is-on' : ''}`} onClick={() => setTab('busqueda')}>
            <Icon name="search" size={15} /> Búsqueda IA
          </button>
        </div>
      )}

      {tab === 'salud' && !isNew ? (
        <SiteHealth siteId={id} />
      ) : tab === 'busqueda' && !isNew ? (
        <EvidenceSearch site={form.name} embedded />
      ) : tab === 'dispositivos' && !isNew ? (
        <SiteDevices siteId={id} />
      ) : (
      <Glass className="panel"><div className="panel__body">
      <div className="site-modal">
        <div className="site-modal__main">
          <div className="form-grid form-grid--2">
            <Field label={<><Icon name="building" size={14} /> Nombre / Cliente</>} hint="Identifica el sitio en eventos y consola.">
              <TextInput autoFocus value={form.name} onChange={set('name')} placeholder="Residencial Las Lomas" />
            </Field>
            <Field label={<><Icon name="hash" size={14} /> Nº de cuenta</>} hint="Cuenta del cliente (tarjeta de evidencia).">
              <TextInput value={form.account} onChange={set('account')} placeholder="CLI-1006" />
            </Field>
            <Field label={<><Icon name="pin" size={14} /> Dirección</>}>
              <TextInput value={form.address} onChange={set('address')} placeholder="Pasaje Las Lomas 120" />
            </Field>
            <Field label={<><Icon name="siren" size={14} /> Nº de emergencia / policía</>} hint="Botón rojo en el popup del evento.">
              <TextInput type="tel" value={form.emergencyNumber} onChange={set('emergencyNumber')} placeholder="133" />
            </Field>
          </div>

          <Field label={<><Icon name="doc" size={14} /> Protocolo de actuación</>} hint="Pasos ante una alarma. Se resalta en el popup.">
            <Textarea value={form.protocol} onChange={set('protocol')} placeholder="1. Verificar cámara. 2. Llamar a contacto principal…" />
          </Field>

          <p className="section-label section-label--action">
            <Icon name="phone" size={14} /> Lista de llamada
            <IconButton icon="plus" size="sm" variant="secondary" label="Añadir contacto" className="section-label__add" onClick={addContact} />
          </p>
          <div className="contacts-editor">
            {(form.contacts || []).length === 0 ? (
              <p className="contacts-editor__empty">Sin contactos. Añade el primero.</p>
            ) : (
              <ul className="contacts-editor__list">
                {form.contacts.map((c, i) => (
                  <li key={i} className="contact-row">
                    <span className="contact-row__rank tnum" aria-hidden="true">{i + 1}</span>
                    <div className="contact-row__fields">
                      <TextInput value={c.name} onChange={setContact(i, 'name')} placeholder="Nombre" aria-label="Nombre del contacto" />
                      <TextInput value={c.role} onChange={setContact(i, 'role')} placeholder="Rol (ej. Encargado)" aria-label="Rol del contacto" />
                      <TextInput type="tel" value={c.phone} onChange={setContact(i, 'phone')} placeholder="Teléfono" aria-label="Teléfono del contacto" />
                    </div>
                    <span className="contact-row__ctl">
                      <IconButton icon="chevron" size="sm" label="Subir" className="icon-rot-up" disabled={i === 0} onClick={() => moveContact(i, -1)} />
                      <IconButton icon="chevron" size="sm" label="Bajar" className="icon-rot-down" disabled={i === form.contacts.length - 1} onClick={() => moveContact(i, 1)} />
                      <IconButton icon="trash" size="sm" label="Quitar" onClick={() => removeContact(i)} />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <Field label={<><Icon name="text" size={14} /> Notas</>}>
            <Textarea value={form.notes} onChange={set('notes')} placeholder="Información adicional…" />
          </Field>
        </div>

        <aside className="site-modal__side">
          <p className="section-label"><Icon name="map" size={14} /> Ubicación del cliente</p>
          <p className="help-block">Haz clic en el mapa (o arrastra el marcador) para fijar la ubicación. Conmuta Calle/Satélite arriba a la derecha.</p>
          <SiteMap lat={latNum} lng={lngNum} onPick={setCoords} height={300} />
          <div className="form-grid form-grid--2 u-mt-12">
            <Field label={<><Icon name="pin" size={14} /> Latitud</>}>
              <TextInput value={form.lat} onChange={set('lat')} placeholder="-33.4489" className="tnum" />
            </Field>
            <Field label={<><Icon name="pin" size={14} /> Longitud</>}>
              <TextInput value={form.lng} onChange={set('lng')} placeholder="-70.6693" className="tnum" />
            </Field>
          </div>
          {(Number.isFinite(latNum) && Number.isFinite(lngNum)) ? (
            <Button variant="ghost" size="sm" icon="x" onClick={() => setCoords('', '')}>Quitar ubicación</Button>
          ) : null}

          <p className="section-label section-label--action u-mt-16">
            <Icon name="speaker" size={14} /> Parlantes / intercomunicadores SIP
            <IconButton icon="plus" size="sm" variant="secondary" label="Añadir parlante" className="section-label__add" onClick={addSpeaker} />
          </p>
          <div className="contacts-editor">
            {(form.speakers || []).length === 0 ? (
              <p className="contacts-editor__empty">Sin parlantes. El operador podrá llamarlos desde el popup.</p>
            ) : (
              <ul className="contacts-editor__list">
                {form.speakers.map((s, i) => (
                  <li key={i} className="speaker-row">
                    <span className="contact-row__ic" aria-hidden="true"><Icon name="speaker" size={14} /></span>
                    <div className="speaker-row__fields">
                      <TextInput value={s.name} onChange={setSpeaker(i, 'name')} placeholder="Nombre (ej. Hall)" aria-label="Nombre del parlante" />
                      <TextInput value={s.zone} onChange={setSpeaker(i, 'zone')} placeholder="Zona" aria-label="Zona del parlante" />
                      <TextInput value={s.sip} onChange={setSpeaker(i, 'sip')} placeholder="URI/ext SIP (ej. 1001@pbx)" aria-label="SIP del parlante" />
                      <TextInput type="tel" value={s.phone} onChange={setSpeaker(i, 'phone')} placeholder="Tel. (alternativa)" aria-label="Teléfono del parlante" />
                    </div>
                    <IconButton icon="trash" size="sm" label="Quitar" onClick={() => removeSpeaker(i)} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>
      </div>
      </div></Glass>
      )}
    </div>
  )
}
