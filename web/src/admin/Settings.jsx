// Configuración — ajustes del sistema. Incluye el panel de Video en vivo / RTSP.
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Panel, Button, Icon, Segmented, Field, TextInput, Spinner } from '../ui/primitives.jsx'
import { PageHead, useToast } from './_shared.jsx'
import { getVideoCfg, putVideoCfg } from '../lib/adminApi.js'

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

function VideoSettings() {
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

  return (
    <Panel title={<span className="ptitle"><Icon name="video" size={16} /> Video en vivo / RTSP</span>}
      subtitle="Cómo se reproduce el vivo de las cámaras y plantillas de URL RTSP por fabricante.">
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

        <p className="section-label u-mt-16"><Icon name="link" size={14} /> Plantillas de URL RTSP</p>
        <p className="help-block">Rutas por fabricante para autocompletar al dar de alta dispositivos. Usa <code>{'{ch}'}</code> como número de canal.</p>
        <div className="vidset__tpls">
          <div className="vidset__tplhead">
            <span>Fabricante</span><span>Principal (…01)</span><span>Subflujo (…02)</span><span />
          </div>
          {(cfg.rtspTemplates || []).map((t, i) => (
            <div className="vidset__tplrow" key={i}>
              <TextInput value={t.vendor} onChange={(e) => setTpl(i, 'vendor', e.target.value)} placeholder="Hikvision" />
              <TextInput value={t.main} onChange={(e) => setTpl(i, 'main', e.target.value)} placeholder="/Streaming/channels/{ch}01" />
              <TextInput value={t.sub} onChange={(e) => setTpl(i, 'sub', e.target.value)} placeholder="/Streaming/channels/{ch}02" />
              <button type="button" className="vidset__del" onClick={() => delTpl(i)} title="Quitar"><Icon name="trash" size={15} /></button>
            </div>
          ))}
          <Button variant="ghost" size="sm" icon="plus" onClick={addTpl} className="u-mt-8">Añadir plantilla</Button>
        </div>

        <div className="u-mt-16" style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button variant="primary" icon={saving ? undefined : 'check'} disabled={saving} onClick={save}>
            {saving ? <Spinner size={15} /> : 'Guardar ajustes de video'}
          </Button>
        </div>
      </div>
    </Panel>
  )
}

export default function Settings() {
  const navigate = useNavigate()
  return (
    <div className="anim-rise">
      <PageHead title="Configuración" subtitle="Ajustes del sistema EventOS." />

      <VideoSettings />

      <Panel className="u-mt-16" title={<span className="ptitle"><Icon name="search" size={16} /> Descubrir equipo</span>}
        subtitle="El descubrimiento de NVR/cámaras Hikvision (ISAPI) vive dentro de Dispositivos.">
        <p className="help-block">
          Para sondear un equipo y registrar sus canales como dispositivos, ve a
          <b> Dispositivos › Descubrir equipo</b>.
        </p>
        <Button variant="primary" icon="device" onClick={() => navigate('/admin/devices/discover')} className="u-mt-12">
          Ir a Descubrir equipo
        </Button>
      </Panel>
    </div>
  )
}
