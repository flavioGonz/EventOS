// Dashboard de salud del NVR — rediseño 360.
// · Skeleton-first: la ESTRUCTURA (tiles, grilla de canales, discos, logs) se dibuja
//   al instante con skeleton loaders; se puebla al llegar /api/admin/nvr/:id/panel.
// · Layout 2 columnas: izquierda = identidad + métricas + canales + discos;
//   derecha = ataques clasificados + logs críticos.
// · Canales: color por estado + badge de MODO DE GRABACIÓN; CLIC → popup con el video
//   en vivo del canal; hover = mini-preview.
// · Discos como iconos SVG (hard-drive) con estado/uso/temperatura/SMART.
// Iconografía Lucide. Sin emojis.
import { useEffect, useState } from 'react'
import { Icon, Spinner } from '../ui/primitives.jsx'
import { getNvrPanel, getNvrHistory } from '../lib/adminApi.js'
import { Go2RtcView } from '../components/CameraLive.jsx'

const fmtUptime = (s) => { if (s == null) return '—'; const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60); if (d > 0) return `${d}d ${h}h`; if (h > 0) return `${h}h ${m}m`; return `${m}m` }
const fmtGB = (mb) => (mb == null ? '—' : mb >= 1024 * 1024 ? `${(mb / 1024 / 1024).toFixed(2)} TB` : `${(mb / 1024).toFixed(0)} GB`)
const fmtRel = (ts) => { if (!ts) return ''; const m = Math.floor((Date.now() - new Date(ts).getTime()) / 60000); if (m < 1) return 'recién'; if (m < 60) return `hace ${m}m`; const h = Math.floor(m / 60); return h < 24 ? `hace ${h}h` : `hace ${Math.floor(h / 24)}d` }
const fmtClock = (ts) => { try { return new Date(ts).toLocaleString([], { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) } catch { return '' } }
const tone = (v, warn, crit) => (v == null ? '' : v >= crit ? 'crit' : v >= warn ? 'warn' : 'ok')

// Modo de grabación → color e ícono.
const REC_UI = {
  continua: { cls: 'cont', icon: 'video', lbl: 'Continua' },
  evento: { cls: 'evt', icon: 'activity', lbl: 'Por evento' },
  movimiento: { cls: 'evt', icon: 'activity', lbl: 'Por movimiento' },
  alarma: { cls: 'evt', icon: 'siren', lbl: 'Por alarma' },
  programada: { cls: 'cont', icon: 'clock', lbl: 'Programada' },
  'sin grabación': { cls: 'off', icon: 'minus', lbl: 'Sin grabación' },
}
const recUi = (rec) => (rec ? (REC_UI[rec.mode] || REC_UI.programada) : null)

// Anillo de progreso SVG.
function Ring({ pct, tone: t }) {
  const r = 15, c = 2 * Math.PI * r, off = c * (1 - Math.min(100, Math.max(0, pct || 0)) / 100)
  return (
    <svg className={`nvrring nvrring--${t}`} viewBox="0 0 40 40" width="40" height="40">
      <circle cx="20" cy="20" r={r} className="nvrring__bg" />
      <circle cx="20" cy="20" r={r} className="nvrring__fg" strokeDasharray={c} strokeDashoffset={off} transform="rotate(-90 20 20)" />
    </svg>
  )
}

function StatTile({ icon, label, value, sub, ring, tone: t, loading }) {
  return (
    <div className={`nvrstat nvrstat--${t || 'neutral'}${loading ? ' is-skel' : ''}`}>
      <span className="nvrstat__lbl"><Icon name={icon} size={13} /> {label}</span>
      <div className="nvrstat__row">
        {ring != null && !loading && <Ring pct={ring} tone={t} />}
        {loading ? <span className="skel skel--val" /> : <strong className="nvrstat__val tnum">{value}</strong>}
      </div>
      {loading ? <span className="skel skel--sub" /> : (sub ? <span className="nvrstat__sub">{sub}</span> : null)}
    </div>
  )
}

// Disco como ICONO SVG (hard-drive).
function DiskIcon({ hdd, i }) {
  const bad = hdd.status && hdd.status.toLowerCase() !== 'ok'
  const quota = !!hdd.quota || (hdd.free === 0 && !bad)
  const used = hdd.capacity - hdd.free
  const pct = (!quota && hdd.capacity) ? Math.round((used / hdd.capacity) * 100) : null
  const hot = hdd.temperature != null && hdd.temperature >= 55
  const st = bad ? 'crit' : (pct != null && pct >= 92) ? 'warn' : 'ok'
  const fillW = pct != null ? Math.max(0, Math.min(30, (pct / 100) * 30)) : 30
  return (
    <div className={`nvrdisk2 nvrdisk2--${st}`} title={`${hdd.name} · ${hdd.status || ''}${pct != null ? ` · ${pct}% usado` : ' · modo cuota'}`}>
      <div className="nvrdisk2__ic">
        <svg viewBox="0 0 48 48" width="52" height="52" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="7" y="10" width="34" height="28" rx="4" />
          <line x1="7" y1="26" x2="41" y2="26" />
          <rect x="9" y="28" width={fillW} height="8" rx="1.5" className={`nvrdisk2__fill${quota ? ' is-quota' : ''}`} stroke="none" />
          <circle cx="13" cy="32" r="1.4" fill="currentColor" stroke="none" />
          <circle cx="34" cy="18" r="1.6" fill="currentColor" stroke="none" />
        </svg>
        <span className="nvrdisk2__badge"><Icon name={bad ? 'alerttri' : 'check'} size={11} /></span>
      </div>
      <div className="nvrdisk2__meta">
        <b>{hdd.name || `Disco ${i + 1}`}</b>
        <span className="tnum">{pct != null ? `${fmtGB(used)} / ${fmtGB(hdd.capacity)} · ${pct}%` : `${fmtGB(hdd.capacity)} · cuota`}</span>
        <span className="nvrdisk2__tags">
          <span className={`nvrdisk2__st nvrdisk2__st--${st}`}>{hdd.status || '—'}</span>
          {hdd.temperature != null && <span className={`nvrdisk2__temp${hot ? ' is-hot' : ''}`}><Icon name="thermometer" size={10} /> {hdd.temperature}°</span>}
          {hdd.hddType && <span className="nvrdisk2__prop">{hdd.hddType}</span>}
          {hdd.smart && hdd.smart.status && <span className="nvrdisk2__prop">SMART {hdd.smart.status}</span>}
          {hdd.smart && hdd.smart.powerOnHours != null && <span className="nvrdisk2__prop">{Math.round(hdd.smart.powerOnHours / 24)}d enc.</span>}
        </span>
      </div>
    </div>
  )
}

// Popup con el video en vivo de un canal.
function ChannelModal({ ch, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const ui = recUi(ch.rec)
  return (
    <div className="nvrmodal" onMouseDown={onClose}>
      <div className="nvrmodal__box" onMouseDown={(e) => e.stopPropagation()}>
        <header className="nvrmodal__head">
          <span className="nvrmodal__ttl"><Icon name="video" size={15} /> Canal {ch.ch}{ch.name ? ` · ${ch.name}` : ''}</span>
          <button type="button" className="nvrmodal__x" onClick={onClose} aria-label="Cerrar"><Icon name="x" size={16} /></button>
        </header>
        <div className="nvrmodal__vid">
          {ch.deviceId
            ? <Go2RtcView deviceId={ch.deviceId} quality="main" priority />
            : <div className="nvrmodal__nomap"><Icon name="wifioff" size={22} /><span>Canal sin cámara EventOS asociada.<br />No hay stream para reproducir.</span></div>}
        </div>
        <footer className="nvrmodal__meta">
          <span className={`nvrslot__rec nvrslot__rec--${ui ? ui.cls : 'off'}`}><Icon name={ui ? ui.icon : 'minus'} size={12} /> {ui ? ui.lbl : 'Grabación desconocida'}</span>
          {ch.rec && ch.rec.codec && <span className="nvrmodal__tag">{ch.rec.codec}</span>}
          {ch.rec && ch.rec.resolution && <span className="nvrmodal__tag">{ch.rec.resolution}</span>}
          <span className={`nvrmodal__tag ${ch.online ? 'is-on' : 'is-off'}`}>{ch.occupied ? (ch.online ? 'En línea' : 'Sin señal') : 'Libre'}</span>
        </footer>
      </div>
    </div>
  )
}

// Gráfica histórica de salud (CPU / memoria / latencia) para comparar en el tiempo.
function HistoryChart({ deviceId }) {
  const [range, setRange] = useState('24h')
  const [pts, setPts] = useState(undefined)
  useEffect(() => {
    if (!deviceId) return
    let alive = true
    setPts(undefined)
    getNvrHistory(deviceId, range).then((r) => { if (alive) setPts((r && r.points) || []) }).catch(() => { if (alive) setPts([]) })
    return () => { alive = false }
  }, [deviceId, range])

  const W = 600, H = 140, PAD = 6
  const series = [
    { key: 'cpu', label: 'CPU', color: 'var(--accent)' },
    { key: 'memPct', label: 'Memoria', color: 'var(--warn, #f59e0b)' },
  ]
  const line = (key) => {
    if (!pts || pts.length < 2) return ''
    const n = pts.length
    return pts.map((p, i) => {
      const v = p[key]
      if (v == null) return null
      const x = PAD + (i / (n - 1)) * (W - 2 * PAD)
      const y = PAD + (1 - Math.min(100, Math.max(0, v)) / 100) * (H - 2 * PAD)
      return `${x.toFixed(1)},${y.toFixed(1)}`
    }).filter(Boolean).join(' ')
  }
  const stat = (key) => {
    const vals = (pts || []).map((p) => p[key]).filter((v) => v != null)
    if (!vals.length) return null
    const avg = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length)
    return { min: Math.min(...vals), max: Math.max(...vals), avg }
  }
  const rttStat = stat('rtt')

  return (
    <section className="nvrdash__sec">
      <p className="nvrdash__lbl"><Icon name="activity" size={14} /> Histórico de salud
        <span className="nvrhist__ranges">
          {['6h', '24h', '7d'].map((r) => (
            <button key={r} type="button" className={`nvrhist__r${range === r ? ' is-on' : ''}`} onClick={() => setRange(r)}>{r}</button>
          ))}
        </span>
      </p>
      {pts === undefined
        ? <div className="nvrhist is-skel" />
        : pts.length < 2
          ? <p className="help-block">Aún se está recolectando el histórico (se muestrea cada 5 min). Volvé en un rato para comparar.</p>
          : (
            <div className="nvrhist">
              <div className="nvrhist__legend">
                {series.map((s) => { const st = stat(s.key); return (
                  <span className="nvrhist__ser" key={s.key}>
                    <i style={{ background: s.color }} /> {s.label}
                    {st && <b className="tnum"> {st.avg}%</b>}{st && <small> (mín {st.min} · máx {st.max})</small>}
                  </span>
                ) })}
                {rttStat && <span className="nvrhist__ser"><i style={{ background: 'var(--text-dim)' }} /> Latencia <b className="tnum"> {rttStat.avg} ms</b></span>}
              </div>
              <svg className="nvrhist__svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
                {[25, 50, 75].map((g) => { const y = PAD + (1 - g / 100) * (H - 2 * PAD); return <line key={g} x1={PAD} y1={y} x2={W - PAD} y2={y} className="nvrhist__grid" /> })}
                {series.map((s) => { const pl = line(s.key); return pl ? <polyline key={s.key} points={pl} fill="none" stroke={s.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" /> : null })}
              </svg>
            </div>
          )}
    </section>
  )
}

export default function NvrHealthDash({ device }) {
  const [d, setD] = useState(undefined)     // undefined=cargando, null=error, obj=datos
  const [modal, setModal] = useState(null)   // canal en popup

  useEffect(() => {
    if (!device || !device.id) return
    let alive = true
    const load = () => getNvrPanel(device.id).then((x) => { if (alive) setD(x || null) }).catch(() => { if (alive) setD(null) })
    load(); const t = setInterval(load, 30000)
    return () => { alive = false; clearInterval(t) }
  }, [device && device.id])

  const loading = d === undefined
  const failed = d === null
  // Nº de slots a dibujar YA (antes de datos): del propio dispositivo, o 16 por defecto.
  const slotCount = (d && d.total) || Number(device && device.channels) || 16
  const memPct = d && d.memTotal ? Math.round((d.memUsed / d.memTotal) * 100) : null
  const rtt = d && d.net && d.net.rttMs
  const channels = (d && d.channels) || []
  const threats = (d && d.threats) || []
  const logs = (d && d.logs) || []

  return (
    <div className="nvrdash">
      {/* Cabecera */}
      <header className="nvrdash__head">
        <span className="nvrdash__logo"><Icon name="device" size={20} /></span>
        <span className="nvrdash__id">
          {loading
            ? <><span className="skel skel--ttl" /><span className="skel skel--sub" /></>
            : <><b>{failed ? (device.name || 'NVR') : d.name}</b>
                <small>{failed ? 'sin respuesta ISAPI' : [d.model, d.firmware ? `FW ${d.firmware}` : null, d.ip].filter(Boolean).join(' · ')}</small></>}
        </span>
        <span className={`nvrdash__badge${loading ? '' : d && d.online ? ' is-on' : ' is-off'}`}>
          {loading ? <Spinner size={13} /> : <span className="dot" />} {loading ? 'Consultando' : (d && d.online ? 'En línea' : 'Sin conexión')}
        </span>
      </header>

      {/* Cuerpo 2 columnas */}
      <div className="nvrdash__grid">
        <div className="nvrdash__main">
          {/* Métricas */}
          <div className="nvrdash__stats">
            <StatTile icon="clock" label="Uptime" value={d && fmtUptime(d.uptime)} tone="neutral" loading={loading} />
            <StatTile icon="cpu" label="CPU" value={d && (d.cpu != null ? `${d.cpu}%` : '—')} ring={d && d.cpu} tone={tone(d && d.cpu, 75, 90)} loading={loading} />
            <StatTile icon="layers" label="Memoria" value={memPct != null ? `${memPct}%` : '—'} ring={memPct} tone={tone(memPct, 85, 95)} loading={loading} />
            <StatTile icon="activity" label="Red" value={rtt != null ? `${rtt} ms` : '—'}
              sub={d && d.net && d.net.linkMbps ? `enlace ${d.net.linkMbps} Mbps` : (rtt != null ? (rtt < 80 ? 'latencia baja' : rtt < 200 ? 'latencia media' : 'latencia alta') : 'sin medir')}
              tone={rtt == null ? 'neutral' : tone(rtt, 200, 500)} loading={loading} />
          </div>

          {/* Histórico de salud (gráfica comparativa) */}
          {!loading && !failed && device && device.id && <HistoryChart deviceId={device.id} />}

          {/* Canales */}
          <section className="nvrdash__sec">
            <p className="nvrdash__lbl"><Icon name="grid" size={14} /> Canales <span className="nvrdash__n">{slotCount}</span>
              <span className="nvrdash__legend">
                <span><i className="nvrslot__dot nvrslot__dot--on" /> ocupado</span>
                <span><i className="nvrslot__dot nvrslot__dot--off" /> sin señal</span>
                <span><i className="nvrslot__dot nvrslot__dot--empty" /> libre</span>
              </span>
            </p>
            <div className="nvrgrid">
              {(channels.length ? channels : Array.from({ length: slotCount }, (_, i) => ({ ch: i + 1, skel: true }))).map((ch) => {
                if (ch.skel) return <div key={ch.ch} className="nvrslot is-skel"><span className="nvrslot__ch tnum">{ch.ch}</span></div>
                const cls = !ch.occupied ? 'is-empty' : ch.online ? 'is-on' : 'is-off'
                const ui = recUi(ch.rec)
                return (
                  <button type="button" key={ch.ch} className={`nvrslot ${cls}${ch.deviceId ? ' has-live' : ''}`}
                    onClick={() => setModal(ch)} title={`Canal ${ch.ch}${ch.name ? ' · ' + ch.name : ''}${ch.rec ? ' · ' + (REC_UI[ch.rec.mode] ? REC_UI[ch.rec.mode].lbl : ch.rec.mode) : ''}`}>
                    <span className="nvrslot__ch tnum">{ch.ch}</span>
                    {ui && <span className={`nvrslot__recdot nvrslot__recdot--${ui.cls}`} />}
                    {ch.occupied && !ch.online && <span className="nvrslot__warn"><Icon name="wifioff" size={11} /></span>}
                  </button>
                )
              })}
            </div>
            {!loading && !failed && <p className="nvrdash__hint"><Icon name="video" size={12} /> Clic en un canal para ver su video en vivo. El punto indica cómo graba.</p>}
          </section>

          {/* Discos */}
          <section className="nvrdash__sec">
            <p className="nvrdash__lbl"><Icon name="harddrive" size={14} /> Discos {d && d.hdds.length > 0 && <span className="nvrdash__n">{d.hdds.length}</span>}</p>
            {loading
              ? <div className="nvrdisks2"><div className="nvrdisk2 is-skel" /><div className="nvrdisk2 is-skel" /></div>
              : (d.hdds.length === 0
                ? <p className="help-block">El grabador no expone información de discos por ISAPI.</p>
                : <div className="nvrdisks2">{d.hdds.map((h, i) => <DiskIcon key={i} hdd={h} i={i} />)}</div>)}
          </section>
        </div>

        {/* Columna derecha: ataques + logs */}
        <aside className="nvrdash__side">
          <section className="nvrdash__sec">
            <p className="nvrdash__lbl"><Icon name="alerttri" size={14} /> Ataques {threats.length > 0 && <span className="nvrdash__n nvrdash__n--crit">{threats.length}</span>}</p>
            {loading
              ? <div className="nvrthreat is-skel" />
              : (threats.length === 0
                ? <p className="help-block">Sin intentos de acceso ilegal detectados.</p>
                : <div className="nvrthreats">
                    {threats.map((t, i) => (
                      <div className={`nvrthreat nvrthreat--${t.kind === 'fuerza_bruta' ? 'crit' : 'warn'}`} key={i}>
                        <span className="nvrthreat__ic"><Icon name="alerttri" size={14} /></span>
                        <span className="nvrthreat__body">
                          <b>{t.kind === 'fuerza_bruta' ? 'Fuerza bruta' : 'Acceso ilegal'} · {t.ip}</b>
                          <small>{t.count} intento{t.count === 1 ? '' : 's'}{t.user ? ` · usuario ${t.user}` : ''} · {fmtRel(t.lastTs)}</small>
                        </span>
                        <span className="nvrthreat__cnt tnum">{t.count}</span>
                      </div>
                    ))}
                  </div>)}
          </section>

          <section className="nvrdash__sec">
            <p className="nvrdash__lbl"><Icon name="list" size={14} /> Logs críticos {logs.length > 0 && <span className="nvrdash__n">{logs.length}</span>}</p>
            {loading
              ? <div className="nvrlogs">{Array.from({ length: 5 }).map((_, i) => <div key={i} className="nvrlog is-skel" />)}</div>
              : (logs.length === 0
                ? <p className="help-block">Sin eventos críticos recientes en el equipo.</p>
                : <div className="nvrlogs nvrlogs--tall">
                    {logs.map((l, i) => (
                      <div className={`nvrlog nvrlog--${l.attack ? 'attack' : l.kind}`} key={i}>
                        <span className="nvrlog__ic"><Icon name={l.attack === 'acceso_ilegal' ? 'alerttri' : l.kind === 'exception' ? 'alerttri' : l.kind === 'alarm' ? 'siren' : 'activity'} size={13} /></span>
                        <span className="nvrlog__body"><b>{l.title}</b>{l.detail ? <small>{l.detail}</small> : null}</span>
                        <span className="nvrlog__time tnum" title={fmtClock(l.ts)}>{fmtRel(l.ts)}</span>
                      </div>
                    ))}
                  </div>)}
          </section>
        </aside>
      </div>

      {failed && <p className="help-block">Sin datos del NVR (¿responde por ISAPI?).</p>}

      {modal && <ChannelModal ch={modal} onClose={() => setModal(null)} />}
    </div>
  )
}
