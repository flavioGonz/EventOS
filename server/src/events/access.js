// access.js — normalizador de eventos de control de acceso y paneles de alarma.
//
// Se registra como un fabricante más (`access`) y no toca a los demás: es
// exactamente el modelo de adaptador que describe el README. Traduce a canónico
// y se va; prioridad, reglas, despacho y consola no saben que existe.
//
// ACEPTA LAS TRES FORMAS EN QUE ESTOS EQUIPOS MANDAN LO MISMO:
//
//   1. JSON del push `httpHosts` (parameterFormatType=JSON) — lo más común en AX
//      y DS-K:   {"ipAddress":"…","AccessControllerEvent":{"majorEventType":5,
//                 "subEventType":28,"doorNo":2,"cardNo":"…"}}
//   2. XML del mismo push (parameterFormatType=XML) o del alertStream local:
//      <EventNotificationAlert><AccessControllerEvent><majorEventType>…
//   3. Objeto ya enriquecido por el ingester de paneles (trae deviceId/site).
//
// Todo lo que no sea un AccessControllerEvent reconocible cae a `system` con el
// crudo guardado: un panel que reporta algo raro tiene que llegar a la consola,
// no desaparecer.

import { mapAccessEvent } from "./accessEvents.js";

const pick = (...v) => v.find((x) => x !== undefined && x !== null && x !== "");

function xmlTag(xml, name) {
  if (typeof xml !== "string") return undefined;
  const m = new RegExp(`<(?:[\\w.-]+:)?${name}[^>]*>([\\s\\S]*?)</(?:[\\w.-]+:)?${name}\\s*>`, "i").exec(xml);
  return m ? m[1].trim() : undefined;
}

/** Saca un objeto plano con los campos del evento, venga como venga. */
export function parseAccessPayload(input) {
  // (3) y (1): ya es objeto
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const ace = input.AccessControllerEvent || input.accessControllerEvent;
    if (ace && typeof ace === "object") {
      return {
        major: ace.majorEventType, sub: ace.subEventType,
        doorNo: pick(ace.doorNo, ace.doorID, ace.DoorNo),
        zone: pick(ace.zoneNo, ace.zone),
        cardNo: ace.cardNo, employeeNo: pick(ace.employeeNoString, ace.employeeNo),
        personName: pick(ace.name, ace.personName),
        deviceName: ace.deviceName,
        serial: ace.serialNo,
        ip: pick(input.ipAddress, input.ipv4Address, ace.remoteHostAddr),
        dateTime: pick(input.dateTime, ace.dateTime),
        raw: input,
      };
    }
    // objeto sin AccessControllerEvent: puede venir del ingester ya aplanado
    if (input.majorEventType != null || input.major != null) {
      return {
        major: pick(input.majorEventType, input.major),
        sub: pick(input.subEventType, input.sub),
        doorNo: pick(input.doorNo, input.door), zone: pick(input.zoneNo, input.zone),
        cardNo: input.cardNo, employeeNo: input.employeeNo,
        personName: pick(input.name, input.personName),
        deviceName: input.deviceName, serial: input.serialNo,
        ip: pick(input.ipAddress, input.ip), dateTime: input.dateTime,
        raw: input,
      };
    }
    // (2) XML envuelto por el ingester como { _raw: "<...>" }
    if (typeof input._raw === "string") return parseAccessPayload(input._raw);
    return { raw: input };
  }
  // (2): XML crudo
  if (typeof input === "string") {
    const ace = /<AccessControllerEvent[\s\S]*?<\/AccessControllerEvent\s*>/i.exec(input);
    const seg = ace ? ace[0] : input;
    return {
      major: xmlTag(seg, "majorEventType"), sub: xmlTag(seg, "subEventType"),
      doorNo: pick(xmlTag(seg, "doorNo"), xmlTag(seg, "doorID")),
      zone: pick(xmlTag(seg, "zoneNo"), xmlTag(seg, "zone")),
      cardNo: xmlTag(seg, "cardNo"),
      employeeNo: pick(xmlTag(seg, "employeeNoString"), xmlTag(seg, "employeeNo")),
      personName: xmlTag(seg, "name"),
      deviceName: pick(xmlTag(input, "deviceName"), xmlTag(seg, "deviceName")),
      serial: xmlTag(input, "serialNo"),
      ip: pick(xmlTag(input, "ipAddress"), xmlTag(input, "ipv4Address")),
      dateTime: xmlTag(input, "dateTime"),
      raw: input,
    };
  }
  return { raw: input };
}

/**
 * Construye el objeto que `normalizeAccess()` le pasa a buildEvent().
 * Se exporta aparte para poder testearlo sin arrastrar todo normalize.js.
 * @returns {null} si el evento es el ECO de una orden nuestra (ver accessEvents).
 */
export function accessFields(input, ctx = {}) {
  const f = parseAccessPayload(input);
  if (f.major == null || f.sub == null) {
    return {
      type: "system", drop: false,
      fields: { ...f, message: "Evento de acceso sin tipificar" },
    };
  }
  const m = mapAccessEvent(f.major, f.sub);

  // El eco de nuestra propia apertura NO genera evento: si no, cada vez que un
  // operario abre una puerta desde la consola le entra una alarma por haberla
  // abierto. Se registra en el log del caso, no como evento nuevo.
  if (m.echo && ctx.dropEcho !== false) return null;

  // Punto canónico: una puerta es un punto igual que una zona de video, así que
  // el registro de puntos le pone el nombre humano sin código nuevo.
  const pointKind = f.doorNo != null ? "door" : (f.zone != null ? "zone" : null);
  const pointId = pick(f.doorNo, f.zone);

  const quien = pick(f.personName, f.employeeNo && `legajo ${f.employeeNo}`,
                     f.cardNo && `tarjeta ${f.cardNo}`);
  return {
    type: m.type,
    drop: false,
    known: m.known,
    fields: {
      ...f.raw && typeof f.raw === "object" ? {} : {},
      majorEventType: Number(f.major), subEventType: Number(f.sub),
      hik: m.hik || null, eventLabel: m.label,
      doorNo: f.doorNo ?? null, zone: f.zone ?? null,
      cardNo: f.cardNo ?? null, employeeNo: f.employeeNo ?? null,
      personName: f.personName ?? null,
      pointKind, pointId,
      message: quien ? `${m.label} · ${quien}` : m.label,
      deviceTs: f.dateTime || null,
    },
    source: {
      deviceId: pick(ctx.deviceId, f.serial) ?? null,
      deviceName: pick(ctx.deviceName, f.deviceName) ?? null,
      channel: pick(f.doorNo, f.zone) ?? null,
      ip: pick(ctx.ip, f.ip) ?? null,
      site: ctx.site ?? null,
    },
  };
}

export default { parseAccessPayload, accessFields };
