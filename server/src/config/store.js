// config/store.js — almacén de configuración persistente (CONTRACT-V2 §1)
//
// Documento JSON único en disco: server/data/eventos.config.json.
// - load/save atómico (escribe .tmp + rename), caché en memoria.
// - Colecciones: sites, devices, operators, rules, procedures, dispatch.
// - En el primer arranque hace SEED desde los defaults v1 (rules/defaults.js,
//   nombres del simulador, catálogo) + política de dispatch por defecto.
// - Nunca tira el server: si el archivo falta o está corrupto, cae al seed.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "../logger.js";
import { RULES as DEFAULT_RULES, PROCEDURES as DEFAULT_PROCEDURES } from "../rules/defaults.js";
import { hashPin } from "../auth/pin.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// server/src/config → server/data
const DATA_DIR = path.resolve(__dirname, "..", "..", "data");
const CONFIG_PATH = path.join(DATA_DIR, "eventos.config.json");

// id corto con prefijo, p.ej. dev_1a2b3c4d
const genId = (prefix) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
const nowIso = () => new Date().toISOString();

// ── Seed ─────────────────────────────────────────────────────────────────

// Procedimientos: del objeto-mapa de defaults v1 a un array
function seedProcedures() {
  return Object.values(DEFAULT_PROCEDURES).map((p) => ({
    id: p.id,
    name: p.name,
    slaSeconds: p.slaSeconds,
    steps: [...(p.steps || [])],
  }));
}

// Reglas: migra las defaults v1 (match + setPriority + procedureId) al shape v2
// (name, enabled, order, match extendido, actions {...}).
function seedRules() {
  return DEFAULT_RULES.map((r, i) => ({
    id: r.id,
    name: r.name || r.id.replace(/^r_/, "").replace(/_/g, " ") || "regla",
    enabled: true,
    order: (i + 1) * 10,
    match: {
      type: r.match?.type || [],
      category: r.match?.category || [],
      deviceId: r.match?.deviceId || [],
      siteId: r.match?.siteId || [],
    },
    actions: {
      setPriority: r.setPriority ?? null,
      procedureId: r.procedureId || null,
      dispatchMode: "simultaneous",
      skills: [],
      operatorIds: [],
    },
  }));
}

// Sites/devices/operators de ejemplo, coherentes con simulator/gen.js.
// Incluyen datos de cliente (CONTRACT-V3 §2): address/account/protocol/contacts,
// para que el popup "Cliente / Contactos" tenga datos de demo.
function seedSites() {
  const defs = [
    {
      name: "Planta Central",
      address: "Av. Industrial 1200, Parque Norte",
      account: "CLI-1001",
      protocol:
        "1) Verificar cámara de la zona. 2) Si hay intrusión confirmada, llamar al jefe de turno. 3) Avisar a la policía si procede.",
      contacts: [
        { name: "Jefe de Turno", role: "Supervisor", phone: "+56 9 1111 1001", order: 1 },
        { name: "Guardia Caseta", role: "Seguridad", phone: "+56 9 1111 1002", order: 2 },
      ],
    },
    {
      name: "Sucursal Norte",
      address: "Calle Comercio 45, Zona Norte",
      account: "CLI-1002",
      protocol: "1) Confirmar el evento por video. 2) Contactar al encargado de sucursal.",
      contacts: [
        { name: "Encargado Sucursal", role: "Administrador", phone: "+56 9 2222 2001", order: 1 },
      ],
    },
    {
      name: "Bodega Sur",
      address: "Ruta 5 Sur Km 18, Galpón B",
      account: "CLI-1003",
      protocol: "1) Verificar panel de alarma. 2) Llamar al responsable de bodega.",
      contacts: [
        { name: "Responsable Bodega", role: "Logística", phone: "+56 9 3333 3001", order: 1 },
        { name: "Contacto Emergencia", role: "Gerencia", phone: "+56 9 3333 3002", order: 2 },
      ],
    },
    {
      name: "Edificio Corporativo",
      address: "Av. Providencia 2300, Piso 12",
      account: "CLI-1004",
      protocol: "1) Revisar el portero. 2) Contactar a conserjería.",
      contacts: [
        { name: "Conserjería", role: "Recepción", phone: "+56 9 4444 4001", order: 1 },
      ],
    },
    {
      name: "Centro Logístico",
      address: "Camino del Centro 980",
      account: "CLI-1005",
      protocol: "1) Verificar NVR. 2) Avisar al coordinador del centro.",
      contacts: [
        { name: "Coordinador", role: "Operaciones", phone: "+56 9 5555 5001", order: 1 },
      ],
    },
    {
      name: "Residencial Las Lomas",
      address: "Pasaje Las Lomas 120",
      account: "CLI-1006",
      protocol: "1) Confirmar el evento. 2) Contactar al administrador del condominio.",
      contacts: [
        { name: "Administración", role: "Administrador", phone: "+56 9 6666 6001", order: 1 },
      ],
    },
  ];
  return defs.map((d) => ({ id: genId("site"), notes: "", ...d }));
}

function seedDevices(sites) {
  const siteId = (name) => sites.find((s) => s.name === name)?.id || null;
  return [
    {
      id: genId("dev"),
      name: "Cámara Acceso Norte",
      type: "hikvision",
      vendor: "Hikvision",
      ip: "192.168.99.50",
      channel: 1,
      siteId: siteId("Planta Central"),
      enabled: true,
      defaultPriority: null,
      tags: ["perímetro"],
    },
    {
      id: genId("dev"),
      name: "Cámara Perímetro Este",
      type: "hikvision",
      vendor: "Hikvision",
      ip: "192.168.99.51",
      channel: 2,
      siteId: siteId("Sucursal Norte"),
      enabled: true,
      defaultPriority: null,
      tags: ["perímetro"],
    },
    {
      id: genId("dev"),
      name: "Portero Principal",
      type: "akuvox",
      vendor: "Akuvox",
      ip: "192.168.99.60",
      channel: 1,
      siteId: siteId("Edificio Corporativo"),
      enabled: true,
      defaultPriority: null,
      tags: ["acceso"],
    },
    {
      id: genId("dev"),
      name: "Central DSC",
      type: "alarm",
      vendor: "DSC",
      ip: "192.168.99.70",
      channel: null,
      siteId: siteId("Bodega Sur"),
      enabled: true,
      defaultPriority: null,
      tags: ["alarma"],
    },
    {
      id: genId("dev"),
      name: "NVR Sala de Control",
      type: "nvr",
      vendor: "NVR",
      ip: "192.168.99.80",
      channel: 1,
      siteId: siteId("Centro Logístico"),
      enabled: true,
      defaultPriority: null,
      tags: [],
    },
  ];
}

function seedOperators() {
  return [
    { id: genId("op"), name: "Ana", skills: ["video", "access", "intrusion"], active: true },
    { id: genId("op"), name: "Bruno", skills: ["video", "system"], active: true },
    { id: genId("op"), name: "Carla", skills: ["access", "intrusion"], active: true },
  ];
}

function seedDispatch() {
  return {
    mode: "simultaneous", // simultaneous | sequential | rules
    sequentialStrategy: "least_loaded", // round_robin | least_loaded
    ackTimeoutSeconds: 30,
    reassignOnTimeout: true,
    maxConcurrentPerOperator: 5,
    skillRouting: true,
  };
}

// Grupos de operarios (CONTRACT-V3 §1b): conjuntos nombrados a los que se puede
// enrutar/transferir eventos. Cada grupo tiene operatorIds y, opcionalmente, skills
// propias que filtran a sus miembros. Se siembran por competencia y SIN miembros
// (el admin asigna los operarios), para no referenciar ids que no existan.
function seedGroups() {
  return [
    { id: genId("group"), name: "Intrusiones", operatorIds: [], skills: ["intrusion", "access"] },
    { id: genId("group"), name: "Video", operatorIds: [], skills: ["video"] },
  ];
}

function buildSeed() {
  const sites = seedSites();
  return {
    sites,
    devices: seedDevices(sites),
    operators: seedOperators(),
    groups: seedGroups(),
    procedures: seedProcedures(),
    rules: seedRules(),
    dispatch: seedDispatch(),
  };
}

// ── Caché + persistencia ───────────────────────────────────────────────────

let cache = null;

// Garantiza que existan todas las colecciones (por si el archivo en disco es viejo)
function normalizeDoc(doc) {
  const seed = buildSeed();
  const out = { ...seed, ...(doc || {}) };
  // dispatch: mezclar defaults para campos faltantes
  out.dispatch = { ...seed.dispatch, ...(doc?.dispatch || {}) };
  for (const k of ["sites", "devices", "operators", "groups", "procedures", "rules"]) {
    if (!Array.isArray(out[k])) out[k] = seed[k];
  }
  return out;
}

function ensureDataDir() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (e) {
    log.warn(`No se pudo crear el dir de datos (${e.message})`);
  }
}

// Carga desde disco; si falta o está corrupto, hace seed y persiste.
export function load() {
  if (cache) return cache;
  ensureDataDir();
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const txt = fs.readFileSync(CONFIG_PATH, "utf8");
      const doc = JSON.parse(txt);
      cache = normalizeDoc(doc);
      log.info(`Config cargada desde ${CONFIG_PATH}`);
      return cache;
    }
  } catch (e) {
    log.warn(`Config corrupta/inaccesible (${e.message}) — re-seed`);
  }
  // Primer arranque (o corrupto): seed
  cache = buildSeed();
  save();
  log.info(`Config sembrada en ${CONFIG_PATH}`);
  return cache;
}

// Guardado atómico: escribe a .tmp y renombra.
export function save() {
  if (!cache) return;
  ensureDataDir();
  const tmp = CONFIG_PATH + ".tmp";
  try {
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), "utf8");
    fs.renameSync(tmp, CONFIG_PATH);
  } catch (e) {
    log.error(`No se pudo guardar la config (${e.message})`);
    try {
      fs.existsSync(tmp) && fs.unlinkSync(tmp);
    } catch {}
  }
}

function db() {
  return cache || load();
}

// ── Getters / setters por colección ─────────────────────────────────────────

export function getConfig() {
  return db();
}

export function getCollection(name) {
  return db()[name];
}

// dispatch (objeto, no array)
export function getDispatch() {
  return db().dispatch;
}

export function setDispatch(patch = {}) {
  const d = db();
  d.dispatch = { ...d.dispatch, ...patch };
  save();
  return d.dispatch;
}

// video (ajustes del vivo/RTSP, objeto)
const DEFAULT_VIDEO = {
  liveMode: "mjpeg",        // 'mjpeg' (snapshots ~10fps, fiable) | 'hls' (H264 transcodificado)
  quality: "sub",           // 'sub' (canal X02, ligero) | 'main' (X01, HD)
  mjpegConcurrency: 6,      // fetches de snapshot en paralelo (más = más fps, más carga NVR)
  rtspTransport: "tcp",     // 'tcp' | 'udp'
  rtspTemplates: [
    { vendor: "Hikvision", main: "/Streaming/channels/{ch}01", sub: "/Streaming/channels/{ch}02" },
    { vendor: "Dahua",     main: "/cam/realmonitor?channel={ch}&subtype=0", sub: "/cam/realmonitor?channel={ch}&subtype=1" },
    { vendor: "ONVIF",     main: "/onvif/profile1/media.smp", sub: "/onvif/profile2/media.smp" },
  ],
};
export function getVideo() {
  return { ...DEFAULT_VIDEO, ...(db().video || {}) };
}
export function setVideo(patch = {}) {
  const d = db();
  d.video = { ...DEFAULT_VIDEO, ...(d.video || {}), ...patch };
  save();
  return d.video;
}

// ── CRUD genérico para colecciones array ─────────────────────────────────────

const ID_PREFIX = {
  sites: "site",
  devices: "dev",
  operators: "op",
  groups: "group",
  rules: "rule",
  procedures: "proc",
};

const COLLECTIONS = Object.keys(ID_PREFIX);

function assertCollection(name) {
  if (!COLLECTIONS.includes(name)) throw new Error(`colección desconocida: ${name}`);
}

export function list(name) {
  assertCollection(name);
  return db()[name];
}

export function get(name, id) {
  assertCollection(name);
  return db()[name].find((x) => x.id === id) || null;
}

// Operarios: el campo `pin` (texto plano del admin) se convierte a `pinHash`
// (scrypt) y NUNCA se guarda en claro. `pin: ''` o `pin: null` borra el PIN.
function applyOperatorPin(data) {
  if (!data || !Object.prototype.hasOwnProperty.call(data, "pin")) return data;
  const { pin, ...rest } = data;
  if (pin === "" || pin === null) { rest.pinHash = null; return rest; }
  const h = hashPin(pin);
  if (h) rest.pinHash = h;
  return rest;
}

export function create(name, data = {}) {
  assertCollection(name);
  const d = db();
  if (name === "operators") data = applyOperatorPin(data);
  // Permite id propuesto (p.ej. procedimientos con id estable); si no, genera.
  const id = data.id && typeof data.id === "string" ? data.id : genId(ID_PREFIX[name]);
  const item = { ...data, id };
  d[name].push(item);
  save();
  return item;
}

export function update(name, id, patch = {}) {
  assertCollection(name);
  const d = db();
  const idx = d[name].findIndex((x) => x.id === id);
  if (idx < 0) return null;
  if (name === "operators") patch = applyOperatorPin(patch);
  // No permitir cambiar el id
  const { id: _ignore, ...rest } = patch;
  d[name][idx] = { ...d[name][idx], ...rest, id };
  save();
  return d[name][idx];
}

export function remove(name, id) {
  assertCollection(name);
  const d = db();
  const idx = d[name].findIndex((x) => x.id === id);
  if (idx < 0) return false;
  d[name].splice(idx, 1);
  save();
  return true;
}

// ── Helpers semánticos usados por el motor de reglas / dispatch ──────────────

// Reglas habilitadas, ordenadas por `order` asc (para evaluación determinista)
export function getRules() {
  return db()
    .rules.filter((r) => r.enabled !== false)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

export function getProcedure(id) {
  return db().procedures.find((p) => p.id === id) || null;
}

export const CONFIG_FILE = CONFIG_PATH;

// ── Evidencia: retención (galería por caso) ──
const DEFAULT_EVIDENCE = { retentionDays: 30, maxFiles: 8000 };
export function getEvidence() { return { ...DEFAULT_EVIDENCE, ...(db().evidence || {}) }; }
export function setEvidence(patch = {}) { const d = db(); d.evidence = { ...DEFAULT_EVIDENCE, ...(d.evidence || {}), ...patch }; save(); return d.evidence; }

export default {
  load,
  save,
  getConfig,
  getCollection,
  getDispatch,
  setDispatch,
  getVideo,
  setVideo,
  list,
  get,
  create,
  update,
  remove,
  getRules,
  getProcedure,
  getEvidence,
  setEvidence,
  CONFIG_FILE,
};
