// catalog.js — catálogo de tipos de evento (CONTRACT §2)
// Cada tipo define category, priority por defecto y title.

export const CATALOG = {
  line_crossing: { category: "video", priority: 2, title: "Cruce de línea" },
  intrusion: { category: "intrusion", priority: 1, title: "Intrusión detectada" },
  region_entrance: { category: "intrusion", priority: 2, title: "Entrada a zona" },
  region_exit: { category: "intrusion", priority: 3, title: "Salida de zona" },
  motion: { category: "video", priority: 4, title: "Movimiento" },
  face: { category: "video", priority: 3, title: "Detección de rostro" },
  lpr: { category: "video", priority: 3, title: "Matrícula (LPR)" },
  tamper: { category: "system", priority: 2, title: "Sabotaje de cámara" },
  video_loss: { category: "system", priority: 2, title: "Pérdida de video" },
  doorbell: { category: "access", priority: 3, title: "Llamada de portero" },
  door_forced: { category: "access", priority: 1, title: "Puerta forzada" },
  door_held: { category: "access", priority: 3, title: "Puerta mantenida abierta" },
  access_denied: { category: "access", priority: 4, title: "Acceso denegado" },
  alarm: { category: "intrusion", priority: 1, title: "Alarma de pánico/intrusión" },
  tamper_alarm: { category: "intrusion", priority: 2, title: "Tamper de central de alarma" },
  system: { category: "system", priority: 5, title: "Evento de sistema" },
};

// Tipo desconocido → tratado como evento de sistema genérico
export const DEFAULT_TYPE = "system";

export function catalogEntry(type) {
  return CATALOG[type] || CATALOG[DEFAULT_TYPE];
}

export default CATALOG;
