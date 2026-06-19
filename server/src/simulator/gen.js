// gen.js — generador de eventos realistas para demo / pruebas de carga
// Produce payloads "crudos" por fabricante (como llegarían a /api/ingest/*),
// para pasar por el mismo pipeline normalize→rules→store→bus.
import { list as listConfig } from "../config/store.js";

const SITES = [
  "Planta Central",
  "Sucursal Norte",
  "Bodega Sur",
  "Edificio Corporativo",
  "Centro Logístico",
  "Residencial Las Lomas",
];

const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const randIp = () => `192.168.${randInt(1, 99)}.${randInt(2, 250)}`;

// Cámaras REALES de la config (con id + ISAPI) → el evento simulado se vincula a
// una cámara de verdad y obtiene FOTO (snapshot ISAPI al ingerir) y PLAYBACK real.
function realCams() {
  try {
    return (listConfig("devices") || []).filter(
      (d) => d && d.id && d.ip && d.isapiPort && d.username &&
             /hikvision/i.test(d.type || "") && Number(d.channel) > 0
    );
  } catch { return []; }
}
function siteNameOf(dev) {
  try {
    if (!dev || !dev.siteId) return null;
    const s = (listConfig("sites") || []).find((x) => x.id === dev.siteId);
    return s ? s.name : null;
  } catch { return null; }
}
// Construye un raw Hikvision sobre una cámara REAL (si hay) con objetivo
// clasificado; si no hay cámaras reales, cae a una ficticia (demo pura).
function hikReal(eventType, fakeNames) {
  const cam = rand(realCams());
  const target = rand(["human", "human", "vehicle"]); // sesgo a humano
  if (cam) {
    return {
      vendor: "hikvision",
      raw: {
        eventType,
        deviceId: cam.id,                    // ← id REAL → foto + playback
        deviceName: cam.name || "Cámara",
        channelID: Number(cam.channel),
        ipAddress: cam.ip,
        site: siteNameOf(cam) || "Cesimco",
        targetType: target,
        dateTime: new Date().toISOString(),
      },
    };
  }
  return {
    vendor: "hikvision",
    raw: {
      eventType, deviceId: `DS-2CD-${randInt(1000, 9999)}`, deviceName: rand(fakeNames),
      channelID: randInt(1, 16), ipAddress: randIp(), site: rand(SITES),
      targetType: rand(["human", "vehicle"]), dateTime: new Date().toISOString(),
    },
  };
}

// Plantillas de eventos por fabricante. Cada una devuelve { vendor, raw }.
const TEMPLATES = [
  // Hikvision — cruce de línea (sobre cámara REAL si la hay → trae foto + playback)
  () => hikReal("linedetection", ["Cámara Acceso Norte", "Cámara Perímetro Este", "Cámara Portón"]),
  // (duplicada para sesgar el burst hacia eventos de cámara real, con evidencia)
  () => hikReal("linedetection", ["Cámara Acceso Norte", "Cámara Perímetro Este", "Cámara Portón"]),
  () => hikReal("fielddetection", ["Cámara Patio", "Cámara Bodega", "Cámara Estacionamiento"]),
  // Hikvision — cruce de línea (variante ficticia original)
  () => ({
    vendor: "hikvision",
    raw: {
      eventType: "linedetection",
      deviceId: `DS-2CD-${randInt(1000, 9999)}`,
      deviceName: rand(["Cámara Acceso Norte", "Cámara Perímetro Este", "Cámara Portón"]),
      channelID: randInt(1, 16),
      ipAddress: randIp(),
      site: rand(SITES),
      dateTime: new Date().toISOString(),
    },
  }),
  // Hikvision — intrusión (field detection)
  () => ({
    vendor: "hikvision",
    raw: {
      eventType: "fielddetection",
      deviceId: `DS-2CD-${randInt(1000, 9999)}`,
      deviceName: rand(["Cámara Patio", "Cámara Bodega", "Cámara Estacionamiento"]),
      channelID: randInt(1, 16),
      ipAddress: randIp(),
      site: rand(SITES),
    },
  }),
  // Hikvision — sabotaje
  () => ({
    vendor: "hikvision",
    raw: {
      eventType: "tamperdetection",
      deviceId: `DS-2CD-${randInt(1000, 9999)}`,
      deviceName: rand(["Cámara Entrada", "Cámara Pasillo"]),
      channelID: randInt(1, 16),
      ipAddress: randIp(),
      site: rand(SITES),
    },
  }),
  // Akuvox — llamada de portero
  () => ({
    vendor: "akuvox",
    raw: {
      event: "call",
      mac: `0C:11:${randInt(10, 99)}:${randInt(10, 99)}:AB:CD`,
      deviceName: rand(["Portero Principal", "Portero Garaje", "Portero Recepción"]),
      door: randInt(1, 4),
      ip: randIp(),
      site: rand(SITES),
    },
  }),
  // Akuvox — puerta forzada
  () => ({
    vendor: "akuvox",
    raw: {
      event: "doorforced",
      mac: `0C:11:${randInt(10, 99)}:${randInt(10, 99)}:AB:CD`,
      deviceName: rand(["Puerta Acceso Empleados", "Puerta Bodega"]),
      door: randInt(1, 4),
      ip: randIp(),
      site: rand(SITES),
    },
  }),
  // NVR — movimiento
  () => ({
    vendor: "nvr",
    raw: {
      type: "motion",
      deviceName: rand(["NVR Sala de Control", "NVR Recepción"]),
      camera: rand(["Cám 03", "Cám 07", "Cám 12"]),
      channel: randInt(1, 32),
      ip: randIp(),
      site: rand(SITES),
    },
  }),
  // NVR — pérdida de video
  () => ({
    vendor: "nvr",
    raw: {
      type: "video_loss",
      deviceName: "NVR Principal",
      channel: randInt(1, 32),
      ip: randIp(),
      site: rand(SITES),
    },
  }),
  // Alarma — intrusión
  () => ({
    vendor: "alarm",
    raw: {
      type: "intrusion",
      panelId: `PNL-${randInt(100, 999)}`,
      panelName: "Central DSC",
      zone: randInt(1, 24),
      zoneName: rand(["Zona Recepción", "Zona Almacén", "Zona Oficinas"]),
      site: rand(SITES),
    },
  }),
  // Alarma — pánico
  () => ({
    vendor: "alarm",
    raw: {
      type: "alarm",
      panelId: `PNL-${randInt(100, 999)}`,
      panelName: "Central Honeywell",
      zone: randInt(1, 24),
      zoneName: "Botón de pánico",
      site: rand(SITES),
    },
  }),
  // Alarma — tamper de central
  () => ({
    vendor: "alarm",
    raw: {
      type: "tamper_alarm",
      panelId: `PNL-${randInt(100, 999)}`,
      panelName: "Central Paradox",
      zone: randInt(1, 24),
      site: rand(SITES),
    },
  }),
];

// Genera un único payload crudo aleatorio
export function generateRaw() {
  return rand(TEMPLATES)();
}

// Genera un lote de N payloads crudos
export function burst(count = 5) {
  const n = Math.max(1, Math.min(Number(count) || 5, 500));
  return Array.from({ length: n }, () => generateRaw());
}

// Control del flujo continuo. `handler(raw)` se invoca por cada evento generado.
let timer = null;

export function start(everyMs, handler) {
  const interval = Math.max(250, Number(everyMs) || 4000);
  stop();
  timer = setInterval(() => {
    try {
      handler(generateRaw());
    } catch {
      /* el handler no debe tirar el simulador */
    }
  }, interval);
  return { running: true, everyMs: interval };
}

export function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
    return { running: false };
  }
  return { running: false };
}

export function isRunning() {
  return timer != null;
}

export default { generateRaw, burst, start, stop, isRunning };
