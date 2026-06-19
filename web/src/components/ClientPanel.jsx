import { useEffect, useState } from 'react'
import { Badge, Button, Icon, Skeleton } from '../ui/primitives.jsx'

// Panel "Cliente / Contactos" (CONTRACT-V3 §2) — centro de RESPUESTA del operador.
// Trae los datos del cliente del sitio del evento desde GET /api/client?site=<site>
// y ofrece, en orden de urgencia y a un toque:
//   1) Llamar a POLICÍA / EMERGENCIAS (número del sitio).
//   2) Lista de llamada priorizada (contactos del cliente) → tel:
//   3) Parlantes / intercomunicadores SIP del cliente → sip: / tel:
// Toda llamada queda registrada en la bitácora vía actions.call. Para eventos
// críticos el panel se resalta para que el operador lo vea al instante.

export default function ClientPanel({ event, actions, critical }) {
  const site = (event && event.source && event.source.site) || ''
  const [state, setState] = useState({ loading: true, error: null, data: null })

  useEffect(() => {
    if (!site) {
      setState({ loading: false, error: null, data: null })
      return
    }
    let alive = true
    setState({ loading: true, error: null, data: null })
    fetch(`/api/client?site=${encodeURIComponent(site)}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((data) => {
        if (alive) setState({ loading: false, error: null, data })
      })
      .catch((err) => {
        if (alive) setState({ loading: false, error: err, data: null })
      })
    return () => {
      alive = false
    }
  }, [site])

  const { loading, error, data } = state
  const clientSite = (data && data.site) || null
  const contacts = ((data && data.contacts) || [])
    .slice()
    .sort((a, b) => (a.order ?? 99) - (b.order ?? 99))
  const speakers = ((data && data.speakers) || [])
    .slice()
    .sort((a, b) => (a.order ?? 99) - (b.order ?? 99))
  const emergency = clientSite && clientSite.emergencyNumber

  const hasData =
    clientSite &&
    (clientSite.account ||
      clientSite.address ||
      clientSite.protocol ||
      emergency ||
      contacts.length > 0 ||
      speakers.length > 0)

  // Registra la llamada en la bitácora. El href tel:/sip: se encarga de marcar.
  function logCall(name, dest) {
    if (actions && actions.call) actions.call(event.id, name, dest)
  }

  return (
    <section
      className={`clientpanel${critical ? ' clientpanel--crit' : ''}`}
      aria-label="Cliente, contactos y respuesta"
    >
      <header className="clientpanel__head">
        <h4 className="clientpanel__title">
          <Icon name="phone" size={15} /> Cliente · Respuesta
        </h4>
        {critical ? (
          <Badge tone="crit" className="clientpanel__flag">
            <Icon name="alert" size={12} /> Llamar ahora
          </Badge>
        ) : null}
      </header>

      {loading ? (
        <div className="clientpanel__skel">
          <Skeleton w="100%" h={44} r="10px" />
          <Skeleton w="58%" h={13} />
          <Skeleton w="100%" h={50} r="10px" />
          <Skeleton w="100%" h={38} r="10px" />
          <Skeleton w="100%" h={38} r="10px" />
        </div>
      ) : !hasData ? (
        <div className="clientpanel__empty">
          <Icon name="user" size={26} />
          <p className="clientpanel__empty-title">Sin datos de cliente</p>
          <p className="clientpanel__empty-sub">
            Configúralos en{' '}
            <a className="clientpanel__link" href="/admin/sites">
              Admin · Sitios
            </a>
            .
          </p>
        </div>
      ) : (
        <>
          {/* 1) Contexto + PROTOCOLO primero (lo que el operador debe seguir) */}
          <div className="clientpanel__card">
            <dl className="clientpanel__facts">
              <Fact icon="hash" label="Cuenta">
                <span className="tnum clientpanel__account">
                  {clientSite.account || '—'}
                </span>
              </Fact>
              <Fact icon="pin" label="Dirección">
                {clientSite.address || '—'}
              </Fact>
            </dl>

            {clientSite.protocol ? (
              <div className="clientpanel__protocol">
                <span className="clientpanel__protocol-lbl">
                  <Icon name="doc" size={13} /> Protocolo de actuación
                </span>
                <p className="clientpanel__protocol-body">{clientSite.protocol}</p>
              </div>
            ) : null}
          </div>

          {/* 3) Lista de llamada priorizada (contactos) */}
          {contacts.length > 0 ? (
            <div className="callgroup">
              <p className="callgroup__lbl"><Icon name="phone" size={13} /> Lista de llamada</p>
              <ul className="calllist">
                {contacts.map((c, i) => (
                  <li key={`${c.name}-${i}`} className="callrow">
                    <span className="callrow__rank tnum" aria-hidden="true">{i + 1}</span>
                    <span className="callrow__info">
                      <span className="callrow__name">
                        <Icon name="user" size={13} /> {c.name || 'Contacto'}
                      </span>
                      <span className="callrow__meta">
                        {c.role ? <Badge tone="neutral" className="callrow__role">{c.role}</Badge> : null}
                        {c.phone ? <span className="callrow__phone tnum">{c.phone}</span> : null}
                      </span>
                    </span>
                    {c.phone ? (
                      <a
                        className="btn btn--primary btn--sm callrow__call"
                        href={`tel:${c.phone}`}
                        onClick={() => logCall(c.name || 'Contacto', c.phone)}
                      >
                        <Icon name="phone" size={15} /><span>Llamar</span>
                      </a>
                    ) : (
                      <Button variant="ghost" size="sm" disabled>Sin tel.</Button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {/* 3b) Escalación a emergencias — secundaria, tras protocolo y lista de llamada */}
          {emergency ? (
            <a
              className="emergency-call emergency-call--sm"
              href={`tel:${emergency}`}
              onClick={() => logCall('Policía / Emergencias', emergency)}
            >
              <span className="emergency-call__ic"><Icon name="siren" size={18} /></span>
              <span className="emergency-call__txt">
                <span className="emergency-call__lbl">Policía / Emergencias</span>
                <span className="emergency-call__num tnum">{emergency}</span>
              </span>
              <Icon name="phone" size={16} />
            </a>
          ) : null}

          {/* 4) Parlantes / intercomunicadores SIP del cliente */}
          {speakers.length > 0 ? (
            <div className="callgroup">
              <p className="callgroup__lbl"><Icon name="speaker" size={13} /> Parlantes SIP del sitio</p>
              <ul className="calllist">
                {speakers.map((s, i) => {
                  const dest = s.sip ? `sip:${s.sip}` : s.phone ? `tel:${s.phone}` : null
                  const shown = s.sip || s.phone || '—'
                  return (
                    <li key={`${s.name}-${i}`} className="callrow callrow--speaker">
                      <span className="callrow__ic" aria-hidden="true"><Icon name="speaker" size={15} /></span>
                      <span className="callrow__info">
                        <span className="callrow__name">{s.name || 'Parlante'}</span>
                        <span className="callrow__meta">
                          {s.zone ? <Badge tone="neutral" className="callrow__role">{s.zone}</Badge> : null}
                          <span className="callrow__phone tnum">{shown}</span>
                        </span>
                      </span>
                      {dest ? (
                        <a
                          className="btn btn--secondary btn--sm callrow__call"
                          href={dest}
                          onClick={() => logCall(`Parlante ${s.name || ''}`.trim(), s.sip || s.phone)}
                        >
                          <Icon name="speaker" size={15} /><span>Audio</span>
                        </a>
                      ) : (
                        <Button variant="ghost" size="sm" disabled>Sin SIP</Button>
                      )}
                    </li>
                  )
                })}
              </ul>
            </div>
          ) : null}

          {error ? (
            <p className="clientpanel__err">No se pudieron actualizar los datos.</p>
          ) : null}
        </>
      )}
    </section>
  )
}

function Fact({ icon, label, children }) {
  return (
    <div className="clientpanel__fact">
      <dt>
        <Icon name={icon} size={12} /> {label}
      </dt>
      <dd>{children}</dd>
    </div>
  )
}
