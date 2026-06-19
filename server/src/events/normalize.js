// normalize.js — normalizadores por fabricante → Event canónico (CONTRACT §1)
// Cada normalizador es tolerante a payloads variados: extrae lo que encuentre,
// aplica defaults del catálogo y conserva el payload original bajo `raw`.

import { randomUUID } from "node:crypto";
import { catalogEntry } from "./catalog.js";

const newId = () => "evt_" + randomUUID();
const nowIso = () => new Date().toISOString();

// Toma el primer valor no vacío de una lista de candidatos
function pick(...vals) {
  for (const v of vals) {
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

function toIso(v) {
  if (!v) return undefined;
  const d = new Date(v);
  return isNaN(d.getTime()) ? undefined : d.toISOString();
}

// Construye el Event canónico combinando defaults de catálogo + overrides del payload
function buildEvent({ sourceType, vendor, raw, type, source, fields = {} }) {
  const entry = catalogEntry(type);
  const category = pick(fields.category, entry.category);
  // Prioridad: si el payload trae algo no numérico (p. ej. "alta"), no propagar NaN;
  // caer a la del catálogo y acotar a 1..5.
  let priority = Number(pick(fields.priority, entry.priority));
  if (!Number.isFinite(priority)) priority = Number(entry.priority) || 5;
  priority = Math.min(5, Math.max(1, Math.round(priority)));
  const title = pick(fields.title, entry.title);

  const ch = source.channel;
  const zone = pick(fields.zone, source.deviceName, source.site);
  // El `title` ya es una frase completa con su género/verbo ("Intrusión detectada",
  // "Puerta forzada", "Llamada de portero"…), así que NO le añadimos "detectado":
  // construimos "<title> en <ubicación> (canal N)", correcto para todos los tipos.
  const loc = zone || vendor;
  const message = pick(
    fields.message,
    `${title}${loc ? ` en ${loc}` : ""}${ch != null ? ` (canal ${ch})` : ""}`
  );

  return {
    id: newId(),
    ts: nowIso(),
    deviceTs: pick(fields.deviceTs, toIso(raw?.dateTime), toIso(raw?.time), toIso(raw?.timestamp)) || null,
    source: {
      type: sourceType,
      vendor,
      deviceId: source.deviceId ?? null,
      deviceName: source.deviceName ?? null,
      channel: source.channel ?? null,
      ip: source.ip ?? null,
      site: source.site ?? null,
    },
    type,
    category,
    priority,
    // Clasificación de objetivo de la cámara (AcuSense/DeepinView): human | vehicle
    // | none (la cámara dice que no hay objetivo relevante → probable falsa) | null
    // (la cámara no clasifica). Se usa para filtrar/priorizar y en reglas.
    target: fields.target ?? null,
    title,
    message,
    media: {
      snapshotUrl: pick(fields.snapshotUrl, raw?.snapshotUrl) || null,
      clipUrl: pick(fields.clipUrl, raw?.clipUrl) || null,
    },
    zone: zone || null,
    procedureId: null, // lo asigna el motor de reglas
    status: "new",
    assignedTo: null,
    disposition: null,
    log: [{ ts: nowIso(), operatorId: null, operatorName: null, action: "receive", note: "" }],
    raw: raw ?? {},
  };
}

// Mapea eventType Hikvision (ISAPI / EventNotificationAlert) → tipo del catálogo.
// Claves normalizadas a minúsculas y sin separadores (ver hikEventKey()).
const HIK_EVENT_MAP = {
  linedetection: "line_crossing",
  fielddetection: "intrusion",
  intrusion: "intrusion",
  regionentrance: "region_entrance",
  regionexiting: "region_exit",
  regionexit: "region_exit",
  vmd: "motion",
  motion: "motion",
  motiondetection: "motion",
  videoloss: "video_loss",
  tamperdetection: "tamper",
  shelteralarm: "tamper",
  scenechangedetection: "tamper",
  facesnap: "face",
  facedetection: "face",
  face: "face",
  anpr: "lpr",
  vehicledetection: "lpr",
  lpr: "lpr",
  io: "alarm",
  alarmlocal: "alarm",
  inputproxy: "alarm",
  alarm: "alarm",
};

// Normaliza un eventType Hik a su clave de mapa: minúsculas, trim, sin guiones/_/espacios.
function hikEventKey(s) {
  return String(s || "").trim().toLowerCase().replace(/[\s_\-]/g, "");
}

// Clasificación de objetivo de la cámara (AcuSense/DeepinView) → human | vehicle |
// none | null. Tolerante a varios nombres de campo y valores según firmware.
//   null  = la cámara NO clasifica (campo ausente) → no filtramos.
//   none  = la cámara clasifica pero sin objetivo relevante → probable falsa alarma.
export function normalizeTarget(raw = {}) {
  const v = String(
    pick(raw.targetType, raw.TargetType, raw.detectionTarget, raw.DetectionTarget,
         raw.objectType, raw.recognitionType, raw.humanType, raw.category, raw.target) || ""
  ).trim().toLowerCase();
  // Algunos eventos Hik vienen tipados (facedetection, ANPR, humanRecognition…).
  const et = String(raw.eventType || "").trim().toLowerCase();
  const hay = v || et;
  if (!hay) return null;
  if (/(human|person|people|pedestrian|\bman\b|head|\bface\b|facedetection)/.test(hay)) return "human";
  if (/(vehicle|\bcar\b|truck|motor|bike|bicycle|cycle|\bvan\b|\bbus\b|plate|\banpr\b|\blpr\b|license)/.test(hay)) return "vehicle";
  if (v && /(none|other|unknown|false|background|no_?target)/.test(v)) return "none";
  return v || null;
}

// ── Parser XML dependency-free ──────────────────────────────────────────────
// Los EventNotificationAlert de Hik son documentos planos; un extractor por tags
// (tolerante a prefijos de namespace y self-closing) es suficiente y robusto.

// Extrae el texto del PRIMER tag <name>…</name> (ignora prefijo namespace, p.ej. <ns:name>).
function xmlTag(xml, name) {
  if (!xml) return undefined;
  const re = new RegExp(
    `<(?:[\\w.-]+:)?${name}\\b[^>]*?>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${name}\\s*>`,
    "i"
  );
  const m = re.exec(xml);
  if (!m) return undefined;
  return decodeXml(m[1].trim());
}

// Decodifica entidades XML básicas y secciones CDATA.
function decodeXml(s) {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

// Si llega multipart/form-data, aísla la subcadena <EventNotificationAlert>…</…>.
function extractAlertXml(text) {
  if (typeof text !== "string") return undefined;
  const m = /<(?:[\w.-]+:)?EventNotificationAlert[\s\S]*?<\/(?:[\w.-]+:)?EventNotificationAlert\s*>/i.exec(
    text
  );
  return m ? m[0] : (text.includes("<") ? text : undefined);
}

// Recorta el raw para no almacenar payloads enormes (snapshots base64, etc.).
function truncateRaw(s, max = 20000) {
  if (typeof s !== "string") return s;
  return s.length > max ? s.slice(0, max) + `…[+${s.length - max} bytes]` : s;
}

// Parsea un EventNotificationAlert (XML string) a un objeto plano con los campos Hik.
function parseHikXml(xml) {
  const region =
    xmlTag(xml, "RegionID") ||
    xmlTag(xml, "regionID") ||
    xmlTag(xml, "regionName") ||
    xmlTag(xml, "RegionName") ||
    xmlTag(xml, "ID"); // dentro de DetectionRegionList/RegionList
  return {
    eventType: xmlTag(xml, "eventType"),
    eventState: xmlTag(xml, "eventState"),
    eventDescription: xmlTag(xml, "eventDescription"),
    dateTime: xmlTag(xml, "dateTime"),
    ipAddress: xmlTag(xml, "ipAddress") || xmlTag(xml, "ipv4Address"),
    channelID: xmlTag(xml, "channelID") || xmlTag(xml, "dynChannelID"),
    channelName: xmlTag(xml, "channelName"),
    deviceID: xmlTag(xml, "deviceID"),
    macAddress: xmlTag(xml, "macAddress"),
    targetType: xmlTag(xml, "targetType"),
    regionID: region,
    licensePlate: xmlTag(xml, "licensePlate") || xmlTag(xml, "plateNumber"),
  };
}

// ── Hikvision ─────────────────────────────────────────────────────────────
// Acepta: (a) objeto JS ya-JSON, (b) string XML EventNotificationAlert,
// (c) string multipart (XML + JPEG). Nunca lanza: ante fallo cae a `system`.
export function normalizeHikvision(input = {}) {
  let raw = input;
  let rawForStore = input;

  try {
    // El parser de body puede entregar un string crudo, o ingest.js lo envuelve como { _raw }.
    let text;
    if (typeof input === "string") text = input;
    else if (input && typeof input._raw === "string") text = input._raw;

    if (typeof text === "string") {
      const alertXml = extractAlertXml(text);
      if (alertXml) {
        raw = parseHikXml(alertXml);
        rawForStore = truncateRaw(alertXml);
      } else {
        raw = {};
        rawForStore = truncateRaw(text);
      }
    } else if (input && typeof input === "object") {
      raw = input;
      rawForStore = input;
    } else {
      raw = {};
    }
  } catch {
    // Malformado: no tiramos, seguimos con lo que haya (cae a system).
    raw = raw && typeof raw === "object" && !raw._raw ? raw : {};
  }

  const key = hikEventKey(pick(raw.eventType, raw.EventType, raw.type, ""));
  const type = HIK_EVENT_MAP[key] || "system";
  const state = String(pick(raw.eventState, "")).trim().toLowerCase();

  const source = {
    deviceId: pick(raw.deviceID, raw.deviceId, raw.macAddress, raw.serialNumber) ?? null,
    deviceName: pick(raw.channelName, raw.deviceName, raw.deviceID, raw.name) ?? null,
    channel: pick(raw.channelID, raw.channel, raw.dynChannelID) ?? null,
    ip: pick(raw.ipAddress, raw.ip, raw.srcIp) ?? null,
    site: pick(raw.site, raw.client) ?? null,
  };

  // Zona = nombre/id de la región detectada (lo que el usuario llama "zonas").
  let zone = pick(
    raw.regionName,
    raw.RegionName,
    raw.regionID != null ? `Región ${raw.regionID}` : undefined
  );
  // LPR: la matrícula es el dato relevante → va a zone/message.
  const plate = pick(raw.licensePlate, raw.plateNumber);
  if (type === "lpr" && plate) zone = `Matrícula ${plate}`;

  // eventState=inactive: evento de "fin" del estado. Política: lo creamos igual
  // pero bajamos una prioridad (menos urgente que el "active"). Documentado en docs/HIKVISION.md.
  const entry = catalogEntry(type);
  let priority = entry.priority;
  if (state === "inactive") priority = Math.min(5, priority + 1);

  const message =
    type === "lpr" && plate
      ? `Matrícula detectada: ${plate}${source.deviceName ? ` en ${source.deviceName}` : ""}`
      : undefined;

  // Objetivo clasificado por la cámara (filtrado de falsas alarmas, nivel 1).
  const target = normalizeTarget(raw);

  return buildEvent({
    sourceType: "hikvision",
    vendor: "Hikvision",
    raw: rawForStore,
    type,
    source,
    fields: {
      ...raw,
      zone,
      priority,
      message,
      target,
      deviceTs: toIso(raw.dateTime),
    },
  });
}

// ── Akuvox (porteros) ───────────────────────────────────────────────────────
const AKUVOX_EVENT_MAP = {
  call: "doorbell",
  doorbell: "doorbell",
  ring: "doorbell",
  dooropen: "access_denied",
  dooropened: "door_held",
  doorforced: "door_forced",
  motion: "motion",
};

export function normalizeAkuvox(raw = {}) {
  const evName = String(pick(raw.event, raw.type, raw.action, "call")).toLowerCase();
  const type = AKUVOX_EVENT_MAP[evName] || "doorbell";

  const source = {
    deviceId: pick(raw.mac, raw.deviceId, raw.sn) ?? null,
    deviceName: pick(raw.deviceName, raw.location, raw.name, "Portero") ?? null,
    channel: pick(raw.door, raw.relay, raw.channel) ?? null,
    ip: pick(raw.ip, raw.ipAddress) ?? null,
    site: pick(raw.site, raw.building, raw.client) ?? null,
  };

  return buildEvent({
    sourceType: "akuvox",
    vendor: "Akuvox",
    raw,
    type,
    source,
    fields: raw,
  });
}

// ── NVR genérico (canal + tipo) ───────────────────────────────────────────
export function normalizeNvr(raw = {}) {
  const type = pick(raw.type, raw.eventType, "motion");

  const source = {
    deviceId: pick(raw.deviceId, raw.nvrId, raw.sn) ?? null,
    deviceName: pick(raw.deviceName, raw.channelName, raw.camera, "Cámara") ?? null,
    channel: pick(raw.channel, raw.channelID, raw.ch) ?? null,
    ip: pick(raw.ip, raw.ipAddress) ?? null,
    site: pick(raw.site, raw.client) ?? null,
  };

  return buildEvent({
    sourceType: "nvr",
    vendor: pick(raw.vendor, "NVR"),
    raw,
    type,
    source,
    fields: raw,
  });
}

// ── Central de alarmas (zona + tipo) ──────────────────────────────────────
export function normalizeAlarm(raw = {}) {
  const type = pick(raw.type, raw.eventType, "alarm");

  const source = {
    deviceId: pick(raw.panelId, raw.deviceId, raw.account) ?? null,
    deviceName: pick(raw.deviceName, raw.panelName, raw.name, "Central de alarma") ?? null,
    channel: pick(raw.zone, raw.partition, raw.channel) ?? null,
    ip: pick(raw.ip, raw.ipAddress) ?? null,
    site: pick(raw.site, raw.client) ?? null,
  };

  const zone = pick(raw.zoneName, raw.zone != null ? `Zona ${raw.zone}` : undefined);

  return buildEvent({
    sourceType: "alarm",
    vendor: pick(raw.vendor, "Alarm"),
    raw,
    type,
    source,
    fields: { ...raw, zone },
  });
}

// ── Genérico (ya viene casi-canónico) ──────────────────────────────────────
export function normalizeGeneric(raw = {}) {
  const type = pick(raw.type, "system");
  const src = raw.source || {};

  const source = {
    deviceId: pick(src.deviceId, raw.deviceId) ?? null,
    deviceName: pick(src.deviceName, raw.deviceName) ?? null,
    channel: pick(src.channel, raw.channel) ?? null,
    ip: pick(src.ip, raw.ip) ?? null,
    site: pick(src.site, raw.site) ?? null,
  };

  return buildEvent({
    sourceType: "generic",
    vendor: pick(src.vendor, raw.vendor, "Generic"),
    raw,
    type,
    source,
    fields: raw,
  });
}

export const normalizers = {
  hikvision: normalizeHikvision,
  akuvox: normalizeAkuvox,
  nvr: normalizeNvr,
  alarm: normalizeAlarm,
  generic: normalizeGeneric,
};

export function normalize(vendor, raw) {
  const fn = normalizers[vendor] || normalizeGeneric;
  return fn(raw);
}

export default normalize;
