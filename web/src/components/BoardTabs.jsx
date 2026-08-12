// BoardTabs — pestañas guardadas por operador para filtrar el tablero de eventos.
// Cada pestaña define filtros: asignación (míos / sin asignar / operarios),
// tipos, sitios, dispositivos, tags y grupos de clientes. Se guardan en el
// navegador por operario (localStorage). La pestaña activa emite un predicado
// (e) => boolean que LiveBoard aplica sobre el stream de eventos.
import { useEffect, useMemo, useState } from 'react'
import { Icon, Button, TextInput } from '../ui/primitives.jsx'
import { eventTypeLabel } from '../lib/labels.js'

const LS = (op) => `eventos.boardtabs.${op || 'anon'}`
const loadTabs = (op) => { try { const a = JSON.parse(localStorage.getItem(LS(op)) || '[]'); return Array.isArray(a) ? a : [] } catch { return [] } }
const saveTabs = (op, t) => { try { localStorage.setItem(LS(op), JSON.stringify(t)) } catch { /* ignore */ } }
const uid = () => 't' + Math.random().toString(36).slice(2, 9)
const emptyF = () => ({ assigned: 'any', operatorIds: [], types: [], siteIds: [], deviceIds: [], tags: [], clientGroupIds: [] })
const siteKey = (e) => String((e.source && e.source.site) || e.site || e.zone || '')

function Chips({ options, selected, onToggle, labelOf, colorOf }) {
  if (!options.length) return <p className="btabs__none">— sin opciones en los eventos actuales —</p>
  return (
    <div className="btabs__chips">
      {options.map((o) => {
        const val = typeof o === 'object' ? o.value : o
        const on = selected.includes(val)
        const c = colorOf ? colorOf(o) : null
        return (
          <button key={val} type="button" className={`btabs__chip${on ? ' is-on' : ''}`} onClick={() => onToggle(val)} style={c ? { '--cg': c } : undefined}>
            {c && <span className="btabs__dot" />}{labelOf ? labelOf(o) : val}
          </button>
        )
      })}
    </div>
  )
}

export default function BoardTabs({ operator, events, onChange }) {
  const opId = operator && operator.operatorId
  const [tabs, setTabs] = useState(() => loadTabs(opId))
  const [activeId, setActiveId] = useState(null)
  const [editing, setEditing] = useState(null) // {id?, name, filters}
  const [sites, setSites] = useState([])
  const [groups, setGroups] = useState([])
  const [ops, setOps] = useState([])

  useEffect(() => { setTabs(loadTabs(opId)) }, [opId])
  useEffect(() => {
    fetch('/api/sites').then((r) => (r.ok ? r.json() : null)).then((d) => setSites((d && d.sites) || [])).catch(() => {})
    fetch('/api/clientGroups').then((r) => (r.ok ? r.json() : null)).then((d) => setGroups((d && d.clientGroups) || [])).catch(() => {})
    fetch('/api/operators').then((r) => (r.ok ? r.json() : null)).then((d) => setOps((d && d.operators) || [])).catch(() => {})
  }, [])

  const ref = useMemo(() => {
    const siteIdByName = {}, groupBySiteId = {}
    for (const s of sites) { if (s.name) siteIdByName[s.name.toLowerCase()] = s.id; if (s.clientGroupId) groupBySiteId[s.id] = s.clientGroupId }
    return { siteIdByName, groupBySiteId, opId }
  }, [sites, opId])

  const opts = useMemo(() => {
    const types = new Set(), devs = new Map(), tags = new Set()
    for (const e of events || []) {
      if (e.type) types.add(e.type)
      const d = e.source && e.source.deviceId; if (d) devs.set(d, (e.source && e.source.deviceName) || d)
      const et = e.tags || (e.source && e.source.tags) || []; for (const t of et) tags.add(t)
    }
    return { types: [...types], devices: [...devs.entries()].map(([value, name]) => ({ value, name })), tags: [...tags] }
  }, [events])

  const activeTab = tabs.find((t) => t.id === activeId) || null

  useEffect(() => {
    if (!activeTab) { onChange(null); return }
    const f = activeTab.filters || emptyF()
    const pred = (e) => {
      if (f.assigned === 'mine' && e.assignedTo !== ref.opId) return false
      if (f.assigned === 'unassigned' && e.assignedTo) return false
      if (f.assigned === 'ops' && !(f.operatorIds || []).includes(e.assignedTo)) return false
      if (f.types && f.types.length && !f.types.includes(e.type)) return false
      const sn = siteKey(e); const sid = ref.siteIdByName[sn.toLowerCase()] || sn
      if (f.siteIds && f.siteIds.length && !(f.siteIds.includes(sid) || f.siteIds.includes(sn))) return false
      if (f.deviceIds && f.deviceIds.length && !f.deviceIds.includes(e.source && e.source.deviceId)) return false
      if (f.tags && f.tags.length) { const et = e.tags || (e.source && e.source.tags) || []; if (!et.some((t) => f.tags.includes(t))) return false }
      if (f.clientGroupIds && f.clientGroupIds.length) { const g = ref.groupBySiteId[sid]; if (!g || !f.clientGroupIds.includes(g)) return false }
      return true
    }
    onChange(pred)
  }, [activeTab, ref]) // eslint-disable-line react-hooks/exhaustive-deps

  const persist = (next) => { setTabs(next); saveTabs(opId, next) }
  const startNew = () => setEditing({ name: '', filters: emptyF() })
  const startEdit = (t) => setEditing({ id: t.id, name: t.name, filters: { ...emptyF(), ...t.filters } })
  const del = (id) => { const next = tabs.filter((t) => t.id !== id); persist(next); if (activeId === id) setActiveId(null) }
  const saveEdit = () => {
    const name = (editing.name || '').trim() || 'Sin nombre'
    if (editing.id) { persist(tabs.map((t) => (t.id === editing.id ? { ...t, name, filters: editing.filters } : t))) }
    else { const t = { id: uid(), name, filters: editing.filters }; persist([...tabs, t]); setActiveId(t.id) }
    setEditing(null)
  }
  const setF = (k, v) => setEditing((ed) => ({ ...ed, filters: { ...ed.filters, [k]: v } }))
  const toggle = (k) => (val) => setEditing((ed) => { const cur = ed.filters[k] || []; const next = cur.includes(val) ? cur.filter((x) => x !== val) : [...cur, val]; return { ...ed, filters: { ...ed.filters, [k]: next } } })

  return (
    <div className="btabs">
      <div className="btabs__bar">
        <button type="button" className={`btabs__tab${activeId === null ? ' is-on' : ''}`} onClick={() => setActiveId(null)}>
          <Icon name="layers" size={13} /> Todos
        </button>
        {tabs.map((t) => (
          <button key={t.id} type="button" className={`btabs__tab${activeId === t.id ? ' is-on' : ''}`} onClick={() => setActiveId(t.id)} onDoubleClick={() => startEdit(t)} title="Doble clic para editar">
            <Icon name="filter" size={12} /> {t.name}
          </button>
        ))}
        <button type="button" className="btabs__add" onClick={startNew} title="Nueva pestaña"><Icon name="plus" size={14} /></button>
        {activeTab && <button type="button" className="btabs__edit" onClick={() => startEdit(activeTab)} title="Editar pestaña"><Icon name="edit" size={13} /></button>}
      </div>

      {editing && (
        <div className="btabs__editor glass glass--strong">
          <div className="btabs__ehead">
            <TextInput autoFocus value={editing.name} onChange={(e) => setEditing((ed) => ({ ...ed, name: e.target.value }))} placeholder="Nombre de la pestaña (ej. Mis edificios)" />
            <span className="btabs__espacer" />
            {editing.id && <Button variant="ghost" size="sm" icon="trash" onClick={() => { del(editing.id); setEditing(null) }}>Eliminar</Button>}
            <Button variant="ghost" size="sm" onClick={() => setEditing(null)}>Cancelar</Button>
            <Button variant="primary" size="sm" icon="check" onClick={saveEdit}>Guardar</Button>
          </div>

          <div className="btabs__sec">
            <span className="btabs__lbl"><Icon name="user" size={12} /> Asignación</span>
            <div className="btabs__chips">
              {[['any', 'Cualquiera'], ['mine', 'Míos'], ['unassigned', 'Sin asignar'], ['ops', 'Operarios…']].map(([v, l]) => (
                <button key={v} type="button" className={`btabs__chip${editing.filters.assigned === v ? ' is-on' : ''}`} onClick={() => setF('assigned', v)}>{l}</button>
              ))}
            </div>
            {editing.filters.assigned === 'ops' && (
              <Chips options={ops.map((o) => ({ value: o.id, name: o.name }))} selected={editing.filters.operatorIds} onToggle={toggle('operatorIds')} labelOf={(o) => o.name} />
            )}
          </div>

          <div className="btabs__sec">
            <span className="btabs__lbl"><Icon name="bell" size={12} /> Tipos de evento</span>
            <Chips options={opts.types} selected={editing.filters.types} onToggle={toggle('types')} labelOf={(t) => eventTypeLabel(t)} />
          </div>

          <div className="btabs__sec">
            <span className="btabs__lbl"><Icon name="building" size={12} /> Grupos de clientes</span>
            <Chips options={groups.map((g) => ({ value: g.id, name: g.name, color: g.color }))} selected={editing.filters.clientGroupIds} onToggle={toggle('clientGroupIds')} labelOf={(g) => g.name} colorOf={(g) => g.color} />
          </div>

          <div className="btabs__sec">
            <span className="btabs__lbl"><Icon name="site" size={12} /> Sitios</span>
            <Chips options={sites.map((s) => ({ value: s.id, name: s.name }))} selected={editing.filters.siteIds} onToggle={toggle('siteIds')} labelOf={(s) => s.name} />
          </div>

          <div className="btabs__sec">
            <span className="btabs__lbl"><Icon name="device" size={12} /> Dispositivos</span>
            <Chips options={opts.devices} selected={editing.filters.deviceIds} onToggle={toggle('deviceIds')} labelOf={(d) => d.name} />
          </div>

          {opts.tags.length > 0 && (
            <div className="btabs__sec">
              <span className="btabs__lbl"><Icon name="hash" size={12} /> Tags</span>
              <Chips options={opts.tags} selected={editing.filters.tags} onToggle={toggle('tags')} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
