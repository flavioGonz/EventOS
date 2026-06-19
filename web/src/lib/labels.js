// Etiquetas en español (i18n) compartidas por el panel admin y la consola.
// Fuente única de traducción de códigos canónicos → texto humano.

export const EVENT_TYPE_LABELS = {
  line_crossing: 'Cruce de línea',
  intrusion:     'Intrusión',
  region_entrance:'Entrada a zona',
  region_exit:   'Salida de zona',
  motion:        'Movimiento',
  face:          'Rostro detectado',
  lpr:           'Matrícula (LPR)',
  tamper:        'Sabotaje de cámara',
  video_loss:    'Pérdida de video',
  doorbell:      'Llamada de portero',
  door_forced:   'Puerta forzada',
  door_held:     'Puerta mantenida abierta',
  access_denied: 'Acceso denegado',
  alarm:         'Alarma',
  tamper_alarm:  'Sabotaje de central',
  system:        'Evento de sistema',
}

export const CATEGORY_LABELS = {
  video: 'Video', access: 'Accesos', intrusion: 'Intrusión', system: 'Sistema',
}

export const DEVICE_TYPE_LABELS = {
  hikvision: 'Hikvision', akuvox: 'Akuvox', nvr: 'NVR / DVR',
  alarm: 'Central de alarma', generic: 'Genérico',
}

// Objetivo clasificado por la cámara (AcuSense/DeepinView) — filtrado de falsas.
export const TARGET_LABELS = { human: 'Humano', vehicle: 'Vehículo', none: 'Sin objetivo' }
export const TARGET_ICON = { human: 'user', vehicle: 'car', none: 'filter' }
export const TARGET_TONE = { human: 'crit', vehicle: 'warn', none: 'neutral' }
export const targetLabel = (t) => TARGET_LABELS[t] || t || '—'

export const DISPATCH_MODE_LABELS = {
  simultaneous: 'Simultáneo', sequential: 'Secuencial', rules: 'Por reglas', inherit: 'Heredar',
}

export const SEQ_STRATEGY_LABELS = {
  round_robin: 'Rotación (round-robin)', least_loaded: 'Menos cargado',
}

export const STATUS_LABELS = {
  new: 'Nuevo', assigned: 'Asignado', ack: 'Con acuse',
  in_progress: 'En curso', resolved: 'Resuelto', escalated: 'Escalado',
}

export const DISPOSITION_LABELS = {
  real: 'Real', false_alarm: 'Falsa alarma', test: 'Prueba', no_action: 'Sin acción',
}

export const PRIORITY_LABELS = {
  1: 'Crítico', 2: 'Alto', 3: 'Medio', 4: 'Bajo', 5: 'Informativo',
}

export const OPERATOR_STATUS_LABELS = {
  available: 'Disponible', paused: 'En pausa', offline: 'Desconectado',
}
export const PAUSE_REASON_LABELS = {
  descanso: 'Descanso', almuerzo: 'Almuerzo', capacitacion: 'Capacitación',
  bano: 'Aseo', otro: 'Otro',
}
export const PAUSE_REASONS = ['descanso', 'almuerzo', 'capacitacion', 'bano', 'otro']

// Icono sugerido (nombre del set en ui/icons.jsx) por tipo de evento / categoría / etc.
export const EVENT_TYPE_ICON = {
  line_crossing:'bolt', intrusion:'alert', region_entrance:'site', region_exit:'site',
  motion:'camera', face:'users', lpr:'device', tamper:'shield', video_loss:'camera',
  doorbell:'bell', door_forced:'alert', door_held:'reception', access_denied:'shield',
  alarm:'bell', tamper_alarm:'shield', system:'device',
}
export const DEVICE_TYPE_ICON = {
  hikvision:'camera', akuvox:'bell', nvr:'device', alarm:'bell', generic:'device',
}

const get = (map, key, fallback) => map[key] ?? (fallback !== undefined ? fallback : key)
export const eventTypeLabel = (t) => get(EVENT_TYPE_LABELS, t)
export const categoryLabel  = (c) => get(CATEGORY_LABELS, c)
export const deviceTypeLabel= (t) => get(DEVICE_TYPE_LABELS, t)
export const dispatchModeLabel = (m) => get(DISPATCH_MODE_LABELS, m)
export const seqStrategyLabel  = (s) => get(SEQ_STRATEGY_LABELS, s)
export const statusLabel    = (s) => get(STATUS_LABELS, s)
export const operatorStatusLabel = (s) => get(OPERATOR_STATUS_LABELS, s)
export const pauseReasonLabel = (r) => get(PAUSE_REASON_LABELS, r)
export const dispositionLabel = (d) => get(DISPOSITION_LABELS, d)
export const priorityLabel  = (p) => get(PRIORITY_LABELS, p, `P${p}`)
