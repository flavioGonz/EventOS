// Grupos de clientes — gestor CRUD. Clasifican los sitios/clientes en categorías
// (Edificios, Obras, Casas, Industria, Campo, Barrio Privado, Residencias) y se
// usan para filtrar eventos en los paneles de operador.
import { useState } from 'react'
import { Panel, Button, Icon, TextInput, Spinner } from '../ui/primitives.jsx'
import { useAdminData } from '../lib/adminApi.js'
import { useToast, confirmDelete } from './_shared.jsx'

const PALETTE = ['#3b82f6', '#f59e0b', '#10b981', '#8b5cf6', '#84cc16', '#06b6d4', '#ec4899', '#ef4444', '#64748b', '#eab308']

function Swatches({ value, onPick }) {
  return (
    <span className="cgmgr__swatches">
      {PALETTE.map((c) => (
        <button key={c} type="button" className={`cgmgr__sw${value === c ? ' is-on' : ''}`}
          style={{ '--cg': c }} onClick={() => onPick(c)} aria-label={`Color ${c}`} />
      ))}
    </span>
  )
}

export default function ClientGroups() {
  const { items, loading, busy, create, update, remove } = useAdminData('clientGroups')
  const toast = useToast()
  const [name, setName] = useState('')
  const [color, setColor] = useState(PALETTE[0])

  const add = async () => {
    const n = name.trim()
    if (!n) { toast('Poné un nombre', 'error'); return }
    try { await create({ name: n, color }); setName(''); toast('Grupo creado') } catch (e) { toast(e.message, 'error') }
  }
  const rename = async (g, v) => { try { await update(g.id, { ...g, name: v }) } catch (e) { toast(e.message, 'error') } }
  const recolor = async (g, c) => { try { await update(g.id, { ...g, color: c }) } catch (e) { toast(e.message, 'error') } }
  const del = async (g) => { if (!confirmDelete(g.name)) return; try { await remove(g.id); toast('Grupo eliminado') } catch (e) { toast(e.message, 'error') } }

  return (
    <Panel title={<span className="ptitle"><Icon name="building" size={16} /> Grupos de clientes</span>}
      subtitle="Clasificá los clientes/sitios en categorías. Se usan para filtrar eventos en los paneles de operador.">
      <div className="cgmgr">
        <div className="cgmgr__add">
          <Swatches value={color} onPick={setColor} />
          <TextInput value={name} onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add()} placeholder="Nuevo grupo (ej. Comercios)" />
          <Button variant="primary" icon="plus" disabled={busy} onClick={add}>Añadir</Button>
        </div>
        {loading ? (
          <div className="admin-center"><Spinner size={20} /><span>Cargando grupos…</span></div>
        ) : (
          <ul className="cgmgr__list">
            {items.length === 0 && <li className="cgmgr__empty">Sin grupos todavía. Añadí el primero arriba.</li>}
            {items.map((g) => (
              <li key={g.id} className="cgmgr__row">
                <span className="cgbadge cgmgr__preview" style={{ '--cg': g.color || '#64748b' }}>{g.name}</span>
                <TextInput defaultValue={g.name}
                  onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== g.name) rename(g, v) }} />
                <Swatches value={g.color || ''} onPick={(c) => recolor(g, c)} />
                <button type="button" className="vidset__del" onClick={() => del(g)} title="Eliminar grupo"><Icon name="trash" size={15} /></button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  )
}
