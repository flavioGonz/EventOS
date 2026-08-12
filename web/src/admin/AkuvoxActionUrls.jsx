// AkuvoxActionUrls.jsx — Botón "Configurar Action URLs automáticamente" para la
// ficha de un portero Akuvox. Abre un modal con una animación SVG de 4 fases
// (Conectar → Leer → Escribir → Verificar) y una tarjeta estilizada que confirma,
// evento por evento, si quedó configurado o no. El trabajo real lo hace el backend
// (POST /api/admin/devices/:id/akuvox/action-urls); acá sólo animamos y mostramos.
import { useState, useRef, useEffect, useCallback } from 'react'
import { Button, Icon, Modal } from '../ui/primitives.jsx'
import { api } from '../lib/adminApi.js'
import { useToast } from './_shared.jsx'

const PHASES = [
  { key: 'connect', label: 'Conectar',      icon: 'link' },
  { key: 'read',    label: 'Leer config',   icon: 'search' },
  { key: 'write',   label: 'Escribir URLs', icon: 'bolt' },
  { key: 'verify',  label: 'Verificar',     icon: 'check' },
]

const STATUS_META = {
  verified: { tone: 'ok',   icon: 'shieldcheck', text: 'Verificado' },
  written:  { tone: 'ok',   icon: 'check',       text: 'Escrito' },
  planned:  { tone: 'acc',  icon: 'bolt',        text: 'Se escribirá' },
  manual:   { tone: 'warn', icon: 'copy',        text: 'A mano' },
  failed:   { tone: 'bad',  icon: 'alert',       text: 'Falló' },
}

function outcomeOf(r) {
  if (!r) return null
  if (!r.reachable) return { kind: 'offline', tone: 'bad', icon: 'globe',
    title: 'No se pudo conectar con el portero',
    sub: 'El equipo no respondió. Encendelo, habilitá su HTTP API y cargá usuario/clave en la ficha; después reintentá.' }
  const s = r.summary || {}
  if (!r.authed) return { kind: 'auth', tone: 'bad', icon: 'shield',
    title: 'Conectó, pero la autenticación falló',
    sub: 'El portero respondió pero rechazó las credenciales. Revisá el usuario/clave del HTTP API en la ficha del equipo.' }
  if ((s.failed || 0) > 0) return { kind: 'partial', tone: 'warn', icon: 'alert',
    title: 'Configuración parcial',
    sub: `${s.auto || 0} de ${s.total || 0} Action URLs quedaron en el equipo; ${s.failed} fallaron.` }
  if ((s.auto || 0) === 0) return { kind: 'manual', tone: 'warn', icon: 'copy',
    title: 'Este modelo no acepta escritura por API',
    sub: 'No expone claves auto-escribibles. Las URLs de abajo quedan listas para pegar en la web del portero (Setting → Action URL).' }
  return { kind: 'ok', tone: 'ok', icon: 'shieldcheck',
    title: r.mode === 'probe' ? 'Listo para configurar' : '¡Action URLs configuradas!',
    sub: r.mode === 'probe'
      ? `Se escribirían ${s.auto} de ${s.total} eventos automáticamente.`
      : `${s.auto} de ${s.total} eventos quedaron configurados y verificados en el portero.` }
}

export default function AkuvoxActionUrls({ deviceId }) {
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [running, setRunning] = useState(false)
  const [phaseIdx, setPhaseIdx] = useState(0)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [mode, setMode] = useState('apply')
  const [inline, setInline] = useState(null)
  const [inlineLoad, setInlineLoad] = useState(true)
  const animRef = useRef(null)

  useEffect(() => () => { if (animRef.current) clearInterval(animRef.current) }, [])

  // Estado inline: al montar consultamos (probe silencioso) si el portero ya
  // tiene las Action URLs configuradas, sin abrir el modal.
  const refreshInline = useCallback(() => {
    setInlineLoad(true)
    api.post(`/devices/${encodeURIComponent(deviceId)}/akuvox/action-urls`, { mode: 'probe' })
      .then((r) => setInline(r)).catch(() => setInline(null)).finally(() => setInlineLoad(false))
  }, [deviceId])
  useEffect(() => { refreshInline() }, [refreshInline])

  const launch = useCallback(async (m) => {
    setMode(m); setError(null); setResult(null); setPhaseIdx(0); setRunning(true); setOpen(true)
    if (animRef.current) clearInterval(animRef.current)
    let i = 0
    animRef.current = setInterval(() => { i = Math.min(i + 1, 3); setPhaseIdx(i) }, 680)
    const minDelay = new Promise((r) => setTimeout(r, 2700))
    try {
      const [res] = await Promise.all([
        api.post(`/devices/${encodeURIComponent(deviceId)}/akuvox/action-urls`, { mode: m }),
        minDelay,
      ])
      if (animRef.current) clearInterval(animRef.current)
      setResult(res); setPhaseIdx(4); setRunning(false); setInline(res)
    } catch (e) {
      if (animRef.current) clearInterval(animRef.current)
      setError(e.message || 'Error inesperado'); setRunning(false)
    }
  }, [deviceId])

  const copy = async (text, msg) => {
    try { await navigator.clipboard.writeText(text); toast(msg || 'Copiado') }
    catch { toast('No se pudo copiar', 'error') }
  }
  const copyAll = () => {
    if (!result || !result.events) return
    copy(result.events.map((e) => e.url).join('\n'), 'URLs copiadas')
  }

  const oc = outcomeOf(result)
  const activeSide = running ? (PHASES[phaseIdx]?.key === 'write' ? 'device' : 'server') : null
  const stepState = (idx) => {
    if (!result) return running ? (idx < phaseIdx ? 'ok' : idx === phaseIdx ? 'active' : 'pending') : 'pending'
    const st = (result.steps || []).find((s) => s.key === PHASES[idx].key)
    return st ? (st.ok ? 'ok' : 'fail') : 'pending'
  }

  return (
    <div className="dev-card akv-card">
      <style>{AKV_CSS}</style>
      <p className="section-label"><Icon name="bolt" size={14} /> Action URLs (recepción de eventos)</p>
      <p className="help-block u-mt-8">
        Cargá de una sola vez, por la API del portero, las URLs que hacen que cada evento
        (tarjeta, PIN, rostro, QR, relé, sabotaje…) llegue a EventOS — sin cargarlas a mano en el equipo.
      </p>
      <style>{".akvi{border:1px solid var(--separator);border-radius:10px;padding:10px 12px;margin-bottom:12px;background:color-mix(in srgb,var(--surface) 60%,transparent)}.akvi--load{display:flex;align-items:center;gap:8px;color:var(--text-faint);font-size:12.5px}.akvi__hd{display:flex;align-items:center;gap:8px;font-size:13px}.akvi__rf{margin-left:auto;border:0;background:transparent;color:var(--text-faint);cursor:pointer;display:inline-flex;padding:2px;border-radius:6px}.akvi__rf:hover{color:var(--text)}.akvi.t-ok .akvi__hd{color:var(--ok)}.akvi.t-warn .akvi__hd{color:var(--warn)}.akvi.t-bad .akvi__hd{color:var(--crit)}.akvi__chips{display:flex;flex-wrap:wrap;gap:5px;margin-top:9px}.akvi__c{display:inline-flex;align-items:center;gap:4px;font-size:10.5px;font-weight:600;padding:3px 7px;border-radius:999px;border:1px solid var(--separator);color:var(--text-dim)}.akvi__c.is-on{color:var(--ok);border-color:color-mix(in srgb,var(--ok) 40%,transparent);background:color-mix(in srgb,var(--ok) 12%,transparent)}.akvi__c.is-man{color:var(--warn);border-color:color-mix(in srgb,var(--warn) 35%,transparent)}.akvi__c.is-off{opacity:.6}"}</style>
      {(() => {
        if (inlineLoad) return <div className="akvi akvi--load"><span className="akv-spin" /> Consultando estado del portero…</div>
        if (!inline) return null
        const evs = inline.events || []
        const isCfg = (e) => e.configured || e.status === 'verified' || e.status === 'written'
        const n = evs.filter(isCfg).length
        const tot = evs.filter((e) => e.cfg).length || evs.length
        let tone = 'ok', label
        if (!inline.reachable) { tone = 'bad'; label = 'Portero sin conexión' }
        else if (!inline.authed) { tone = 'bad'; label = 'Autenticación rechazada' }
        else if (n === 0) { tone = 'warn'; label = 'Sin Action URLs configuradas' }
        else if (n < tot) { tone = 'warn'; label = `${n} de ${tot} configuradas` }
        else { tone = 'ok'; label = `Todas configuradas (${n}/${tot})` }
        return (
          <div className={`akvi t-${tone}`}>
            <div className="akvi__hd">
              <Icon name={tone === 'ok' ? 'shieldcheck' : tone === 'warn' ? 'alert' : 'globe'} size={15} />
              <b>{label}</b>
              <button type="button" className="akvi__rf" title="Volver a consultar" onClick={refreshInline}><Icon name="refresh" size={12} /></button>
            </div>
            {inline.reachable && inline.authed && (
              <div className="akvi__chips">
                {evs.map((e) => {
                  const on = isCfg(e); const man = e.status === 'manual'
                  return <span key={e.event} className={`akvi__c ${on ? 'is-on' : man ? 'is-man' : 'is-off'}`} title={e.note || e.label}><Icon name={on ? 'check' : man ? 'copy' : 'dot'} size={10} /> {e.label}</span>
                })}
              </div>
            )}
          </div>
        )
      })()}
      <div className="akv-actions u-mt-12">
        <Button variant="primary" icon="bolt" onClick={() => launch('apply')}>Configurar automáticamente</Button>
        <Button variant="ghost" icon="search" onClick={() => launch('probe')}>Previsualizar</Button>
      </div>

      {open && (
        <Modal open={open} onClose={() => !running && setOpen(false)} size="lg"
          title={<span className="ptitle"><Icon name="bolt" size={16} /> Configurar Action URLs · Akuvox</span>}>
          <div className="akv-modal">
            {/* Escena animada */}
            <div className={`akv-scene ${running ? 'is-running' : ''}`} data-active={activeSide || ''}>
              <svg viewBox="0 0 560 190" width="100%" role="img" aria-label="Flujo de configuración">
                <defs>
                  <linearGradient id="akvWire" x1="0" y1="0" x2="1" y2="0">
                    <stop offset="0" stopColor="var(--accent)" stopOpacity="0.15" />
                    <stop offset="0.5" stopColor="var(--accent)" stopOpacity="0.9" />
                    <stop offset="1" stopColor="var(--accent)" stopOpacity="0.15" />
                  </linearGradient>
                </defs>

                {/* Cable */}
                <line x1="168" y1="95" x2="392" y2="95" className="akv-wire" />
                {running && <line x1="168" y1="95" x2="392" y2="95" className="akv-wire-flow"
                  style={{ animationDirection: activeSide === 'device' ? 'reverse' : 'normal' }} />}
                {running && (
                  <g>
                    <circle r="5" className="akv-packet">
                      <animateMotion dur="1.35s" repeatCount="indefinite"
                        path={activeSide === 'device' ? 'M392,95 L168,95' : 'M168,95 L392,95'} />
                    </circle>
                  </g>
                )}

                {/* Nodo servidor (EventOS) */}
                <g className={`akv-node ${activeSide === 'server' ? 'is-active' : ''}`}>
                  {activeSide === 'server' && <circle cx="96" cy="95" r="52" className="akv-ring" />}
                  <rect x="52" y="55" width="88" height="80" rx="12" className="akv-box" />
                  <rect x="66" y="70" width="60" height="9" rx="4" className="akv-line2" />
                  <rect x="66" y="87" width="60" height="9" rx="4" className="akv-line2" />
                  <rect x="66" y="104" width="38" height="9" rx="4" className="akv-line2" />
                  <circle cx="118" cy="108" r="4" className="akv-led" />
                  <text x="96" y="152" className="akv-caption" textAnchor="middle">EventOS</text>
                </g>

                {/* Nodo portero (Akuvox) */}
                <g className={`akv-node ${activeSide === 'device' ? 'is-active' : ''}`}>
                  {activeSide === 'device' && <circle cx="464" cy="95" r="52" className="akv-ring" />}
                  <rect x="436" y="48" width="56" height="94" rx="12" className="akv-box" />
                  <circle cx="464" cy="68" r="7" className="akv-cam" />
                  <rect x="449" y="86" width="30" height="8" rx="4" className="akv-line2" />
                  <g className="akv-keys">
                    <circle cx="452" cy="108" r="3.4" /><circle cx="464" cy="108" r="3.4" /><circle cx="476" cy="108" r="3.4" />
                    <circle cx="452" cy="120" r="3.4" /><circle cx="464" cy="120" r="3.4" /><circle cx="476" cy="120" r="3.4" />
                  </g>
                  <text x="464" y="160" className="akv-caption" textAnchor="middle">Portero</text>
                </g>
              </svg>
            </div>

            {/* Chips de fase */}
            <div className="akv-steps">
              {PHASES.map((p, idx) => {
                const st = stepState(idx)
                const detail = result && (result.steps || []).find((s) => s.key === p.key)?.detail
                return (
                  <div key={p.key} className={`akv-step is-${st}`} title={detail || ''}>
                    <span className="akv-step__dot">
                      {st === 'ok' ? <Icon name="check" size={14} />
                        : st === 'fail' ? <Icon name="alert" size={14} />
                        : st === 'active' ? <span className="akv-spin" />
                        : <Icon name={p.icon} size={13} />}
                    </span>
                    <span className="akv-step__lbl">{p.label}</span>
                  </div>
                )
              })}
            </div>

            {/* Resultado */}
            {error && (
              <div className="akv-outcome t-bad akv-in">
                <span className="akv-badge"><Icon name="alert" size={22} /></span>
                <div><p className="akv-outcome__t">No se pudo ejecutar</p><p className="akv-outcome__s">{error}</p></div>
              </div>
            )}

            {oc && !error && (
              <>
                <div className={`akv-outcome t-${oc.tone} akv-in`}>
                  <span className="akv-badge">
                    {oc.kind === 'ok'
                      ? <svg viewBox="0 0 52 52" width="30" height="30" className="akv-check"><circle cx="26" cy="26" r="24" className="akv-check__c" /><path d="M15 27 l7 7 l15 -16" className="akv-check__k" /></svg>
                      : <Icon name={oc.icon} size={22} />}
                  </span>
                  <div>
                    <p className="akv-outcome__t">{oc.title}</p>
                    <p className="akv-outcome__s">{oc.sub}</p>
                    {result.device && (result.device.model || result.device.firmware) && (
                      <p className="akv-meta">{[result.device.model, result.device.firmware && `fw ${result.device.firmware}`, result.device.mac].filter(Boolean).join(' · ')}</p>
                    )}
                  </div>
                </div>

                <div className="akv-evhead">
                  <span>{(result.events || []).length} eventos</span>
                  <button type="button" className="akv-copyall" onClick={copyAll}><Icon name="copy" size={13} /> Copiar todas las URLs</button>
                </div>
                <div className="akv-evlist">
                  {(result.events || []).map((e) => {
                    const m = STATUS_META[e.status] || STATUS_META.manual
                    return (
                      <div key={e.event} className={`akv-ev t-${m.tone}`}>
                        <span className="akv-ev__ic"><Icon name={e.icon || 'dot'} size={14} /></span>
                        <span className="akv-ev__lbl">{e.label}</span>
                        <span className={`akv-ev__st t-${m.tone}`}><Icon name={m.icon} size={12} /> {m.text}</span>
                        <button type="button" className="akv-ev__copy" title="Copiar URL" onClick={() => copy(e.url, 'URL copiada')}><Icon name="copy" size={13} /></button>
                      </div>
                    )
                  })}
                </div>

                <div className="akv-footer">
                  {result.mode === 'probe'
                    ? <Button variant="primary" icon="bolt" onClick={() => launch('apply')} disabled={running || !result.reachable}>Configurar ahora</Button>
                    : <Button variant="secondary" icon="refresh" onClick={() => launch('apply')} disabled={running}>Reintentar</Button>}
                  <Button variant="ghost" onClick={() => setOpen(false)} disabled={running}>Cerrar</Button>
                </div>
              </>
            )}

            {running && !result && !error && (
              <p className="akv-progress">{PHASES[phaseIdx]?.label}…</p>
            )}
          </div>
        </Modal>
      )}
    </div>
  )
}

const AKV_CSS = `
.akv-card .akv-actions{display:flex;gap:10px;flex-wrap:wrap}
.akv-modal{display:flex;flex-direction:column;gap:16px}
.akv-scene{background:var(--bg-elev,rgba(127,127,127,.06));border:1px solid var(--border);border-radius:14px;padding:6px 10px}
.akv-wire{stroke:var(--border);stroke-width:3;stroke-linecap:round}
.akv-wire-flow{stroke:url(#akvWire);stroke-width:3;stroke-linecap:round;stroke-dasharray:10 12;animation:akvflow .9s linear infinite}
@keyframes akvflow{to{stroke-dashoffset:-44}}
.akv-packet{fill:var(--accent);filter:drop-shadow(0 0 6px var(--accent))}
.akv-box{fill:var(--bg,#fff);stroke:var(--border);stroke-width:2}
.akv-line2{fill:var(--text-faint,#c4c4c4);opacity:.6}
.akv-cam{fill:var(--text-dim,#8a8a8a)}
.akv-keys circle{fill:var(--text-faint,#c4c4c4);opacity:.7}
.akv-led{fill:var(--ok,#16a34a)}
.akv-caption{fill:var(--text-dim,#8a8a8a);font-size:12px;font-weight:600;font-family:inherit}
.akv-node.is-active .akv-box{stroke:var(--accent)}
.akv-node.is-active .akv-caption{fill:var(--accent)}
.akv-ring{fill:none;stroke:var(--accent);stroke-width:2;opacity:.5;transform-origin:center;transform-box:fill-box;animation:akvpulse 1.5s ease-out infinite}
@keyframes akvpulse{0%{transform:scale(.72);opacity:.55}70%{transform:scale(1.08);opacity:0}100%{opacity:0}}
.akv-steps{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
.akv-step{display:flex;align-items:center;gap:8px;padding:9px 11px;border-radius:10px;border:1px solid var(--border);background:var(--bg-elev,transparent);font-size:12.5px;font-weight:600;color:var(--text-dim);transition:.25s}
.akv-step__dot{display:grid;place-items:center;width:24px;height:24px;border-radius:50%;background:var(--border);color:var(--text-dim);flex-shrink:0}
.akv-step.is-active{border-color:var(--accent);color:var(--text)}
.akv-step.is-active .akv-step__dot{background:color-mix(in srgb,var(--accent) 22%,transparent);color:var(--accent)}
.akv-step.is-ok{border-color:color-mix(in srgb,var(--ok,#16a34a) 55%,var(--border));color:var(--text)}
.akv-step.is-ok .akv-step__dot{background:var(--ok,#16a34a);color:#fff}
.akv-step.is-fail{border-color:color-mix(in srgb,#e5484d 55%,var(--border))}
.akv-step.is-fail .akv-step__dot{background:#e5484d;color:#fff}
.akv-spin{width:13px;height:13px;border-radius:50%;border:2px solid currentColor;border-top-color:transparent;animation:akvspin .7s linear infinite}
@keyframes akvspin{to{transform:rotate(360deg)}}
.akv-outcome{display:flex;gap:13px;align-items:flex-start;padding:14px;border-radius:12px;border:1px solid var(--border)}
.akv-outcome.t-ok{background:color-mix(in srgb,var(--ok,#16a34a) 10%,transparent);border-color:color-mix(in srgb,var(--ok,#16a34a) 40%,var(--border))}
.akv-outcome.t-warn{background:color-mix(in srgb,var(--warn,#d97706) 10%,transparent);border-color:color-mix(in srgb,var(--warn,#d97706) 40%,var(--border))}
.akv-outcome.t-bad{background:color-mix(in srgb,#e5484d 10%,transparent);border-color:color-mix(in srgb,#e5484d 40%,var(--border))}
.akv-badge{flex-shrink:0;display:grid;place-items:center;width:44px;height:44px;border-radius:50%;background:var(--bg,#fff);border:1px solid var(--border)}
.akv-outcome.t-ok .akv-badge{color:var(--ok,#16a34a)}
.akv-outcome.t-warn .akv-badge{color:var(--warn,#d97706)}
.akv-outcome.t-bad .akv-badge{color:#e5484d}
.akv-outcome__t{font-weight:700;font-size:15px;margin:0}
.akv-outcome__s{margin:3px 0 0;font-size:13px;color:var(--text-dim);line-height:1.5}
.akv-meta{margin:6px 0 0;font-size:11.5px;color:var(--text-faint);font-family:ui-monospace,Menlo,monospace}
.akv-in{animation:akvin .45s cubic-bezier(.2,.8,.2,1)}
@keyframes akvin{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
.akv-check__c{fill:none;stroke:var(--ok,#16a34a);stroke-width:3;stroke-dasharray:151;stroke-dashoffset:151;animation:akvdraw .5s ease forwards}
.akv-check__k{fill:none;stroke:var(--ok,#16a34a);stroke-width:4;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:40;stroke-dashoffset:40;animation:akvdraw .4s .35s ease forwards}
@keyframes akvdraw{to{stroke-dashoffset:0}}
.akv-evhead{display:flex;align-items:center;justify-content:space-between;font-size:12px;color:var(--text-dim);font-weight:600}
.akv-copyall{display:inline-flex;align-items:center;gap:5px;background:none;border:1px solid var(--border);border-radius:8px;padding:5px 9px;color:var(--text-dim);cursor:pointer;font:inherit;font-size:12px}
.akv-copyall:hover{border-color:var(--accent);color:var(--accent)}
.akv-evlist{display:grid;grid-template-columns:1fr 1fr;gap:7px;max-height:230px;overflow:auto;padding-right:2px}
.akv-ev{display:flex;align-items:center;gap:8px;padding:7px 9px;border-radius:9px;border:1px solid var(--border);background:var(--bg-elev,transparent);font-size:12.5px}
.akv-ev__ic{color:var(--text-dim);display:grid;place-items:center;flex-shrink:0}
.akv-ev__lbl{flex:1;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.akv-ev__st{display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:600;padding:2px 7px;border-radius:20px;flex-shrink:0}
.akv-ev__st.t-ok{background:color-mix(in srgb,var(--ok,#16a34a) 16%,transparent);color:var(--ok,#16a34a)}
.akv-ev__st.t-warn{background:color-mix(in srgb,var(--warn,#d97706) 16%,transparent);color:var(--warn,#d97706)}
.akv-ev__st.t-acc{background:color-mix(in srgb,var(--accent) 16%,transparent);color:var(--accent)}
.akv-ev__st.t-bad{background:color-mix(in srgb,#e5484d 16%,transparent);color:#e5484d}
.akv-ev__copy{background:none;border:none;color:var(--text-faint);cursor:pointer;padding:2px;display:grid;place-items:center;flex-shrink:0}
.akv-ev__copy:hover{color:var(--accent)}
.akv-footer{display:flex;gap:9px;justify-content:flex-end;margin-top:4px}
.akv-progress{text-align:center;color:var(--text-dim);font-size:13px;font-weight:600;margin:0}
@media(max-width:640px){.akv-steps{grid-template-columns:repeat(2,1fr)}.akv-evlist{grid-template-columns:1fr}}
`
