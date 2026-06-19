import { createContext, useContext, useEffect, useState, useCallback } from 'react'

const ThemeCtx = createContext({ theme: 'dark', toggle: () => {}, setTheme: () => {} })
const LS_KEY = 'eventos.theme'

function initialTheme() {
  // Consola de operación = oscuro por defecto (identidad "command center").
  // Migración v2: la primera vez forzamos oscuro (aunque hubiera un 'light'
  // viejo guardado por el default antiguo basado en el sistema), para que todos
  // estrenen la identidad nueva. Después se respeta la elección explícita.
  try {
    if (!localStorage.getItem('eventos.theme.v2')) {
      localStorage.setItem('eventos.theme.v2', '1')
      localStorage.setItem(LS_KEY, 'dark')
      return 'dark'
    }
    const saved = localStorage.getItem(LS_KEY)
    if (saved === 'dark' || saved === 'light') return saved
  } catch { /* ignore */ }
  return 'dark'
}

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(initialTheme)

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    try { localStorage.setItem(LS_KEY, theme) } catch { /* ignore */ }
  }, [theme])

  const setTheme = useCallback((t) => setThemeState(t === 'light' ? 'light' : 'dark'), [])
  const toggle = useCallback(() => setThemeState((t) => (t === 'dark' ? 'light' : 'dark')), [])

  return <ThemeCtx.Provider value={{ theme, toggle, setTheme }}>{children}</ThemeCtx.Provider>
}

export function useTheme() {
  return useContext(ThemeCtx)
}
