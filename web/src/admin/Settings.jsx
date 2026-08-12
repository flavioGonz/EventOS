// Configuración — ajustes del sistema, agrupados en pestañas:
// Reproducción en vivo · Plantillas RTSP · Endpoints de ingesta.
import { useEffect, useState } from 'react'
import { Panel, Button, Icon, Segmented, Field, TextInput, Spinner } from '../ui/primitives.jsx'
import { PageHead, useToast } from './_shared.jsx'
import { getVideoCfg, putVideoCfg } from '../lib/adminApi.js'
import IngestEndpoints from './IngestEndpoints.jsx'
import ClientGroups from './ClientGroups.jsx'

const MODE_OPTS = [
  { value: 'mjpeg', label: 'MJPEG (snapshots)' },
  { value: 'hls', label: 'HLS (H.264)' },
]
const QUALITY_OPTS = [
  { value: 'sub', label: 'Subflujo (ligero)' },
  { value: 'main', label: 'Principal (HD)' },
]
const TRANSPORT_OPTS = [
  { value: 'tcp', label: 'TCP' },
  { value: 'udp', label: 'UDP' },
]

// Plantillas RTSP por defecto para cada fabricante soportado. {ch} = nº de canal.
// Editables en la UI; se cargan con «Cargar marcas por defecto» sin pisar las existentes.
const DEFAULT_RTSP_TEMPLATES = [
  { vendor: 'Hikvision', main: '/Streaming/Channels/{ch}01', sub: '/Streaming/Channels/{ch}02' },
  { vendor: 'Dahua', main: '/cam/realmonitor?channel={ch}&subtype=0', sub: '/cam/realmonitor?channel={ch}&subtype=1' },
  { vendor: 'Tiandy', main: '/{ch}/1', sub: '/{ch}/2' },
  { vendor: 'Uniview', main: '/unicast/c{ch}/s0/live', sub: '/unicast/c{ch}/s1/live' },
  { vendor: 'Siera', main: '/cam/realmonitor?channel={ch}&subtype=0', sub: '/cam/realmonitor?channel={ch}&subtype=1' },
  { vendor: 'Intelbras', main: '/cam/realmonitor?channel={ch}&subtype=0', sub: '/cam/realmonitor?channel={ch}&subtype=1' },
  { vendor: 'Akuvox', main: '/live/ch00_0', sub: '/live/ch00_1' },
  { vendor: 'ONVIF', main: '', sub: '' },
]

function VideoSettings({ view }) {
  const toast = useToast()
  const [cfg, setCfg] = useState(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    getVideoCfg().then(setCfg).catch((e) => toast(e.message || 'No se pudo cargar', 'error'))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  if (!cfg) return <div className="admin-center"><Spinner size={20} /><span>Cargando ajustes…</span></div>

  const set = (k, v) => setCfg((c) => ({ ...c, [k]: v }))
  const setTpl = (i, k, v) => setCfg((c) => ({ ...c, rtspTemplates: c.rtspTemplates.map((t, j) => (j === i ? { ...t, [k]: v } : t)) }))
  const addTpl = () => setCfg((c) => ({ ...c, rtspTemplates: [...(c.rtspTemplates || []), { vendor: '', main: '', sub: '' }] }))
  const delTpl = (i) => setCfg((c) => ({ ...c, rtspTemplates: c.rtspTemplates.filter((_, j) => j !== i) }))
  const loadDefaults = () => setCfg((c) => {
    const have = new Set((c.rtspTemplates || []).map((t) => (t.vendor || '').trim().toLowerCase()))
    const missing = DEFAULT_RTSP_TEMPLATES.filter((d) => !have.has(d.vendor.toLowerCase()))
    if (!missing.length) { toast('Ya están todas las marcas cargadas'); return c }
    toast(`${missing.length} marca(s) agregada(s) — revisá y guardá`)
    return { ...c, rtspTemplates: [...(c.rtspTemplates || []), ...missing] }
  })

  const save = async () => {
    setSaving(true)
    try {
      const saved = await putVideoCfg({
        liveMode: cfg.liveMode, quality: cfg.quality, rtspTransport: cfg.rtspTransport,
        mjpegConcurrency: Number(cfg.mjpegConcurrency) || 6, rtspTemplates: cfg.rtspTemplates,
      })
      setCfg(saved); toast('Ajustes de video guardados')
    } catch (e) { toast(e.message || 'No se pudo guardar', 'error') }
    setSaving(false)
  }

  const saveBtn = (
    <div className="u-mt-16" style={{ display: 'flex', justifyContent: 'flex-end' }}>
      <Button variant="primary" icon={saving ? undefined : 'check'} disabled={saving} onClick={save}>
        {saving ? <Spinner size={15} /> : 'Guardar ajustes de video'}
      </Button>
    </div>
  )

  if (view === 'templates') {
    return (
      <Panel title={<span className="ptitle"><Icon name="link" size={16} /> Plantillas de URL RTSP</span>}
        subtitle="Rutas RTSP por fabricante para autocompletar el vivo al dar de alta dispositivos.">
        <div className="vidset">
          <p className="help-block">Ruta RTSP de cada marca. Usá <code>{'{ch}'}</code> como número de canal (el server antepone <code>rtsp://usuario:clave@ip:puerto</code>). Principal = flujo HD; Subflujo = ligero.</p>
          <div className="vidset__tpls">
            <div className="vidset__tplhead">
              <span>Fabricante</span><span>Principal (HD)</span><span>Subflujo (ligero)</span><span />
            </div>
            {(cfg.rtspTemplates || []).length === 0 && (
              <div className="relay-empty"><Icon name="link" size={16} /> Sin plantillas. Usá «Cargar marcas por defecto».</div>
            )}
            {(cfg.rtspTemplates || []).map((t, i) => (
              <div className="vidset__tplrow" key={i}>
                <TextInput value={t.vendor} onChange={(e) => setTpl(i, 'vendor', e.target.value)} placeholder="Hikvision" />
                <TextInput value={t.main} onChange={(e) => setTpl(i, 'main', e.target.value)} placeholder="/Streaming/Channels/{ch}01" />
                <TextInput value={t.sub} onChange={(e) => setTpl(i, 'sub', e.target.value)} placeholder="/Streaming/Channels/{ch}02" />
                <button type="button" className="vidset__del" onClick={() => delTpl(i)} title="Quitar"><Icon name="trash" size={15} /></button>
              </div>
            ))}
            <div className="u-mt-8" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Button variant="secondary" size="sm" icon="download" onClick={loadDefaults}>Cargar marcas por defecto</Button>
              <Button variant="ghost" size="sm" icon="plus" onClick={addTpl}>Añadir plantilla</Button>
            </div>
          </div>
          {saveBtn}
        </div>
      </Panel>
    )
  }

  return (
    <Panel title={<span className="ptitle"><Icon name="video" size={16} /> Reproducción en vivo</span>}
      subtitle="Cómo se reproduce el vivo de las cámaras (modo, calidad y transporte).">
      <div className="vidset">
        <Field label={<><Icon name="layers" size={14} /> Modo de reproducción</>}
          hint="MJPEG = snapshots (fiable ~10fps, recomendado con este NVR). HLS = H.264 transcodificado (real-time cuando el stream llega sano, p. ej. con H.264+ apagado).">
          <Segmented value={cfg.liveMode} onChange={(v) => set('liveMode', v)} options={MODE_OPTS} />
        </Field>

        <div className="form-grid form-grid--2 u-mt-12">
          <Field label={<><Icon name="filter" size={14} /> Calidad / canal</>} hint="Subflujo (…02) es más rápido; Principal (…01) es HD pero más pesado.">
            <Segmented value={cfg.quality} onChange={(v) => set('quality', v)} options={QUALITY_OPTS} />
          </Field>
          <Field label={<><Icon name="globe" size={14} /> Transporte RTSP</>} hint="TCP es más estable; UDP puede bajar latencia en LAN.">
            <Segmented value={cfg.rtspTransport} onChange={(v) => set('rtspTransport', v)} options={TRANSPORT_OPTS} />
          </Field>
        </div>

        <Field label={<><Icon name="bolt" size={14} /> Fluidez MJPEG (peticiones en paralelo)</>}
          hint="Más alto = más fps, pero más carga al NVR. Recomendado 5–8. El NVR topa ~10fps." className="u-mt-12">
          <TextInput type="number" min="1" max="16" value={cfg.mjpegConcurrency ?? 6}
            onChange={(e) => set('mjpegConcurrency', e.target.value)} style={{ maxWidth: 120 }} />
        </Field>
        {saveBtn}
      </div>
    </Panel>
  )
}

export default function Settings() {
  const [tab, setTab] = useState('playback')
  const TABS = [
    { k: 'playback', icon: 'video', label: 'Reproducción en vivo' },
    { k: 'templates', icon: 'link', label: 'Plantillas RTSP' },
    { k: 'ingest', icon: 'reception', label: 'Endpoints de ingesta' },
    { k: 'cgroups', icon: 'building', label: 'Grupos de clientes' },
  ]
  return (
    <div className="anim-rise">
      <PageHead title="Configuración" subtitle="Ajustes del sistema EventOS." />

      <div className="subtabs settings-tabs">
        {TABS.map((t) => (
          <button type="button" key={t.k} className={`subtab${tab === t.k ? ' is-on' : ''}`} onClick={() => setTab(t.k)}>
            <Icon name={t.icon} size={15} /> {t.label}
          </button>
        ))}
      </div>

      {/* VideoSettings queda montado en las dos primeras pestañas para no perder ediciones sin guardar */}
      <div style={{ display: (tab === 'ingest' || tab === 'cgroups') ? 'none' : undefined }}>
        <VideoSettings view={tab === 'templates' ? 'templates' : 'playback'} />
      </div>
      <div style={{ display: tab === 'ingest' ? undefined : 'none' }}>
        <IngestEndpoints />
      </div>
      {tab === 'cgroups' && <ClientGroups />}
    </div>
  )
}
