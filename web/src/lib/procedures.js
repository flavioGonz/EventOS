// Procedimientos por defecto del MVP (CONTRACT §5) embebidos como fallback
// cuando el evento trae un procedureId pero el server no expone los pasos.
// Mantener alineado con server/src/rules/defaults.js.

export const PROCEDURES = {
  proc_intrusion: {
    id: 'proc_intrusion',
    name: 'Intrusión confirmada',
    slaSeconds: 60,
    steps: [
      'Verificar video en vivo del canal afectado',
      'Confirmar si hay personas en zona',
      'Avisar a vigilancia física / patrulla',
      'Si confirmado: llamar al 911 y notificar al cliente',
      'Registrar disposición y cerrar',
    ],
  },
  proc_line_crossing: {
    id: 'proc_line_crossing',
    name: 'Cruce de línea',
    slaSeconds: 120,
    steps: [
      'Abrir snapshot y video del canal',
      'Determinar si el cruce es relevante o tránsito normal',
      'Si es relevante, dar seguimiento con vigilancia',
      'Registrar disposición y cerrar',
    ],
  },
  proc_door_forced: {
    id: 'proc_door_forced',
    name: 'Puerta forzada',
    slaSeconds: 60,
    steps: [
      'Verificar estado de la puerta en video/acceso',
      'Confirmar si hubo apertura no autorizada',
      'Avisar a vigilancia física',
      'Notificar al cliente si se confirma',
      'Registrar disposición y cerrar',
    ],
  },
  proc_doorbell: {
    id: 'proc_doorbell',
    name: 'Llamada de portero',
    slaSeconds: 90,
    steps: [
      'Atender la llamada del portero',
      'Identificar al visitante',
      'Validar autorización con el cliente',
      'Abrir puerta o denegar según protocolo',
      'Registrar disposición y cerrar',
    ],
  },
  proc_video_loss: {
    id: 'proc_video_loss',
    name: 'Pérdida / sabotaje de video',
    slaSeconds: 180,
    steps: [
      'Confirmar pérdida de señal del canal',
      'Verificar conectividad del dispositivo',
      'Escalar a soporte técnico si persiste',
      'Notificar al cliente',
      'Registrar disposición y cerrar',
    ],
  },
  proc_generic: {
    id: 'proc_generic',
    name: 'Procedimiento general',
    slaSeconds: 300,
    steps: [
      'Revisar el detalle del evento',
      'Verificar la fuente (cámara / dispositivo / zona)',
      'Tomar la acción que corresponda',
      'Registrar disposición y cerrar',
    ],
  },
}

// Cache de procedimientos obtenidos del server (si existiera endpoint).
const fetched = {}

export function getProcedureFallback(procedureId) {
  if (!procedureId) return PROCEDURES.proc_generic
  return PROCEDURES[procedureId] || PROCEDURES.proc_generic
}

// Intenta el server primero; si no hay endpoint, usa el fallback embebido.
export async function fetchProcedure(procedureId) {
  if (!procedureId) return getProcedureFallback(null)
  if (fetched[procedureId]) return fetched[procedureId]
  try {
    const res = await fetch(`/api/procedures/${procedureId}`)
    if (res.ok) {
      const data = await res.json()
      const proc = data.procedure || data
      if (proc && Array.isArray(proc.steps)) {
        fetched[procedureId] = proc
        return proc
      }
    }
  } catch {
    /* sin endpoint: usar fallback */
  }
  return getProcedureFallback(procedureId)
}
