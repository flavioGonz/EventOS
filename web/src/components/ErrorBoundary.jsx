// ErrorBoundary — evita la "pantalla en blanco" de una consola 24/7. Un render que
// lance (un payload inesperado, un event.source nulo) desmontaría todo el árbol de
// React y dejaría al operador ciego a las alarmas. Este límite atrapa el error, deja
// el resto de la app viva y ofrece reintentar sin recargar toda la página.
import { Component } from 'react'

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }
  static getDerivedStateFromError(error) {
    return { error }
  }
  componentDidCatch(error, info) {
    // Deja rastro en consola del navegador para diagnóstico; no rompe nada.
    try { console.error('[EventOS] error capturado por ErrorBoundary:', error, info) } catch { /* noop */ }
  }
  reset = () => this.setState({ error: null })
  render() {
    const { error } = this.state
    if (!error) return this.props.children
    if (typeof this.props.fallback === 'function') return this.props.fallback(error, this.reset)
    const compact = this.props.compact
    return (
      <div className={`errboundary${compact ? ' errboundary--compact' : ''}`} role="alert">
        <div className="errboundary__box">
          <b className="errboundary__title">{this.props.title || 'Algo falló al mostrar esto'}</b>
          <p className="errboundary__msg">{String(error && error.message || error)}</p>
          <div className="errboundary__actions">
            <button type="button" className="errboundary__btn" onClick={this.reset}>Reintentar</button>
            {!compact && <button type="button" className="errboundary__btn" onClick={() => location.reload()}>Recargar</button>}
          </div>
        </div>
      </div>
    )
  }
}
