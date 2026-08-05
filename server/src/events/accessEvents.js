// accessEvents.js — traduce los eventos de control de acceso y paneles de alarma
// Hikvision al catálogo canónico de EventOS.
//
// EL PROBLEMA. Un panel AX o una controladora DS-K no manda un `eventType` con
// nombre como las cámaras: manda dos NÚMEROS.
//
//   {"AccessControllerEvent": {"majorEventType": 5, "subEventType": 28, …}}
//
// Y vienen en DECIMAL aunque el manual los tabula en hexadecimal — `0x1c` se
// transmite como `28`. Sin esta tabla el evento llega a la consola como
// "evento 5/28" y el operario no tiene forma de saber que eso significa que una
// puerta quedó abierta.
//
// FUENTE. `Access Control Event Types and Event Linkage Types.pdf` (Hikvision),
// 780 códigos extraídos el 4-ago-2026. Los cinco tipos mayores:
//   1 alarma · 2 excepción · 3 operación · 4 información · 5 otros
//
// Acá abajo sólo están los que EventOS ACCIONA. La tabla completa, para mostrar
// una descripción legible de cualquier otro código, vive en
// server/data/access-event-types.json y es opcional: si no está, el evento igual
// se procesa, sólo que con un título genérico.

import { readFileSync } from "node:fs";
import { resolve as pathResolve } from "node:path";

// ── Los códigos que importan ────────────────────────────────────────────────
// `major:sub` → tipo canónico del catálogo de EventOS (events/catalog.js).
//
// Sobre `door_held`: son TRES códigos distintos que significan lo mismo para el
// operario — la puerta se quedó abierta. `28` es el contacto magnético que pasó
// el tiempo permitido, `216` es la alarma explícita del panel, y `11` es el caso
// de esclusa. Los tres van al mismo tipo para no multiplicar procedimientos.
export const ACCESS_EVENT_MAP = {
  // Cada entrada lleva el codigo hex del manual (`hik`) y su texto original
  // en ingles (`en`) al lado de la etiqueta en castellano, para poder
  // contrastarla contra el PDF sin salir del archivo. La tabla se genero
  // desde `access-event-types.json`, no se transcribio a mano.
  "5:28": { type: "door_held", label: "Puerta abierta fuera de tiempo",
      hik: "0x1c", en: "Door Open Timed Out (Contact)" },
  "5:216": { type: "door_held", label: "Alarma de puerta sin cerrar",
      hik: "0xd8", en: "Door Not-Closed Alarm" },
  "5:11": { type: "door_held", label: "Esclusa: puerta sin cerrar",
      hik: "0x0b", en: "Interlocking Door Not Closed" },
  "5:93": { type: "door_held", label: "Desbloqueo fuera de tiempo",
      hik: "0x5d", en: "Unlocking Timed Out" },
  "5:27": { type: "door_forced", label: "Puerta abierta anormalmente (forzada)",
      hik: "0x1b", en: "Door Abnormally Open (Contact)" },
  "5:25": { type: "access_granted", label: "Puerta abierta (contacto)",
      hik: "0x19", en: "Door Open (Contact)" },
  "5:26": { type: "access_granted", label: "Puerta cerrada (contacto)",
      hik: "0x1a", en: "Door Closed (Contact)" },
  "5:19": { type: "system", label: "Puerta liberada: inicio",
      hik: "0x13", en: "Remain Open Started" },
  "5:20": { type: "system", label: "Puerta liberada: fin",
      hik: "0x14", en: "Remain Open Stopped" },
  "5:31": { type: "system", label: "Puerta bloqueada: inicio",
      hik: "0x1f", en: "Remain Closed Started" },
  "5:32": { type: "system", label: "Puerta bloqueada: fin",
      hik: "0x20", en: "Remain Closed Stopped" },
  "5:215": { type: "system", label: "Alarma de puerta que no abrio",
      hik: "0xd7", en: "Door Not-Opened Alarm" },
  "5:92": { type: "system", label: "Excepcion al desbloquear",
      hik: "0x5c", en: "Unlocking Exception" },
  "5:117": { type: "access_denied", label: "Autenticacion fallida con puerta bloqueada",
      hik: "0x75", en: "Authentication Failed: Door Remain Closed or Door in Sleeping" },
  "5:37": { type: "doorbell", label: "Timbre",
      hik: "0x25", en: "Doorbell Ring" },
  "5:2066": { type: "system", label: "Puerta fuera de linea",
      hik: "0x812", en: "Door Offline" },
  "1:1034": { type: "alarm", label: "Coaccion (duress)",
      hik: "0x40a", en: "Duress Alarm" },
  "1:1052": { type: "alarm", label: "Boton de panico",
      hik: "0x41c", en: "Panic Button Triggered" },
  "1:1032": { type: "alarm", label: "Entrada de alarma activada",
      hik: "0x408", en: "Alarm Input Alarm Triggered" },
  "1:1026": { type: "alarm", label: "Zona en excepcion",
      hik: "0x402", en: "Zone Exception Alarm" },
  "1:1024": { type: "tamper_alarm", label: "Zona en cortocircuito",
      hik: "0x400", en: "Zone Short Circuit Attempts Alarm" },
  "1:1025": { type: "tamper_alarm", label: "Zona desconectada",
      hik: "0x401", en: "Zone Disconnected Alarm" },
  "1:1028": { type: "tamper_alarm", label: "Sabotaje de zona",
      hik: "0x404", en: "Zone Tampering Alarm" },
  "1:1030": { type: "tamper_alarm", label: "Sabotaje de lectora",
      hik: "0x406", en: "Card Reader Tampering Alarm" },
  "1:1039": { type: "tamper_alarm", label: "Sabotaje de la unidad de control de puerta",
      hik: "0x40f", en: "Secure Door Control Unit Tampering Alarm" },
  "1:1027": { type: "system", label: "Zona restaurada",
      hik: "0x403", en: "Zone Restored" },
  "1:1029": { type: "system", label: "Sabotaje de zona restaurado",
      hik: "0x405", en: "Zone Tampering Restored" },
  "1:1036": { type: "access_denied", label: "Maximo de autenticaciones fallidas",
      hik: "0x40c", en: "Maximum Failed Card Authentications Alarm" },
  "1:1089": { type: "access_denied", label: "Intentos de clave excedidos",
      hik: "0x441", en: "Failed Attempts of Opening Door via Password Exceeded Limit" },
  "3:1024": { type: "system", label: "Puerta abierta remotamente", echo: true,
      hik: "0x400", en: "Door Remotely Open" },
  "3:1025": { type: "system", label: "Puerta cerrada remotamente", echo: true,
      hik: "0x401", en: "Door Remotely Closed" },
  "3:1026": { type: "system", label: "Puerta liberada remotamente", echo: true,
      hik: "0x402", en: "Remain Open Remotely" },
  "3:1027": { type: "system", label: "Puerta bloqueada remotamente", echo: true,
      hik: "0x403", en: "Remain Closed Remotely" },
};

// ── Tabla completa (opcional, sólo para el texto descriptivo) ───────────────
const FILE = process.env.EVENTOS_ACCESS_TYPES_FILE ||
  pathResolve(process.cwd(), "server/data/access-event-types.json");
const MAJOR_KEY = { 1: "alarm", 2: "exception", 3: "operation", 4: "info", 5: "other" };

let table = null;
function loadTable() {
  if (table) return table;
  try {
    table = JSON.parse(readFileSync(FILE, "utf8"));
  } catch {
    table = {};
  }
  return table;
}

/** Descripción del manual para un par (major, sub), o null. */
export function describeAccessEvent(major, sub) {
  const t = loadTable();
  const bucket = t[MAJOR_KEY[Number(major)]];
  const hit = bucket && bucket[String(sub)];
  return hit ? hit.desc : null;
}

/**
 * Traduce (major, sub) al tipo canónico.
 * @returns {{type,label,echo,known}} — `known:false` cuando el código no está
 *   mapeado: el evento se procesa igual, como `system`, con la descripción del
 *   manual si la hay. Preferimos un evento genérico y visible a tragarnos algo
 *   que el equipo consideró digno de reportar.
 */
export function mapAccessEvent(major, sub) {
  const key = `${Number(major)}:${Number(sub)}`;
  const hit = ACCESS_EVENT_MAP[key];
  if (hit) return { ...hit, echo: !!hit.echo, known: true };
  const desc = describeAccessEvent(major, sub);
  return {
    type: "system",
    label: desc || `Evento de acceso ${major}/${sub}`,
    echo: false,
    known: false,
  };
}

/** ¿Este evento es el eco de una orden que mandamos nosotros? */
export function isEcho(major, sub) {
  return mapAccessEvent(major, sub).echo;
}

export default { ACCESS_EVENT_MAP, mapAccessEvent, describeAccessEvent, isEcho };
