// defaults.js — reglas + procedimientos seed (CONTRACT §5)

// Reglas: mapean condiciones del evento → prioridad efectiva + procedimiento.
// Se evalúan en orden; la primera que coincide aplica setPriority y procedureId.
export const RULES = [
  {
    id: "r_intrusion",
    name: "Intrusión / alarma",
    match: { type: ["intrusion", "alarm", "door_forced"] },
    setPriority: 1,
    procedureId: "proc_intrusion",
  },
  {
    id: "r_region",
    name: "Entrada / salida de zona",
    match: { type: ["region_entrance", "region_exit"] },
    setPriority: 2,
    procedureId: "proc_zone_crossing",
  },
  {
    id: "r_line_crossing",
    name: "Cruce de línea",
    match: { type: ["line_crossing"] },
    procedureId: "proc_line_crossing",
  },
  {
    id: "r_doorbell",
    name: "Llamada de portero",
    match: { type: ["doorbell"] },
    procedureId: "proc_doorbell",
  },
  {
    // Regla por defecto: coincide con cualquier evento
    id: "r_default",
    name: "Por defecto",
    match: {},
    procedureId: "proc_generic",
  },
];

// Procedimientos: checklists que el operario sigue en el popup.
export const PROCEDURES = {
  proc_intrusion: {
    id: "proc_intrusion",
    name: "Intrusión confirmada",
    slaSeconds: 60,
    steps: [
      "Verificar video en vivo del canal afectado",
      "Confirmar si hay personas en zona",
      "Avisar a vigilancia física / patrulla",
      "Si confirmado: llamar al 911 y notificar al cliente",
      "Registrar disposición y cerrar",
    ],
  },
  proc_line_crossing: {
    id: "proc_line_crossing",
    name: "Cruce de línea",
    slaSeconds: 120,
    steps: [
      "Revisar snapshot / video del cruce",
      "Determinar si es persona, vehículo o falso positivo",
      "Si es relevante: notificar a vigilancia",
      "Registrar disposición y cerrar",
    ],
  },
  proc_zone_crossing: {
    id: "proc_zone_crossing",
    name: "Entrada / salida de zona",
    slaSeconds: 90,
    steps: [
      "Revisar snapshot / video de la zona afectada",
      "Identificar la zona (región) y si el objetivo es persona o vehículo",
      "Confirmar si la entrada/salida está autorizada según el horario del cliente",
      "Si es relevante: notificar a vigilancia",
      "Registrar disposición y cerrar",
    ],
  },
  proc_doorbell: {
    id: "proc_doorbell",
    name: "Llamada de portero",
    slaSeconds: 90,
    steps: [
      "Atender la llamada del portero",
      "Verificar identidad del visitante",
      "Autorizar o denegar la apertura según protocolo del cliente",
      "Registrar disposición y cerrar",
    ],
  },
  proc_generic: {
    id: "proc_generic",
    name: "Procedimiento genérico",
    slaSeconds: 300,
    steps: [
      "Revisar el evento y su contexto",
      "Verificar video / estado del dispositivo si aplica",
      "Tomar la acción correspondiente",
      "Registrar disposición y cerrar",
    ],
  },
};

export default { RULES, PROCEDURES };
