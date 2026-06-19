// redisBus.js — bus de eventos con Redis (pub/sub) y fallback en memoria (CONTRACT §6)
//
// Si REDIS_URL está definido y conecta: pub/sub en canal `eventos:events` +
// lista `eventos:recent` (recortada a 500). Si no, fallback EventEmitter + array.
// El server NO debe caer si Redis está caído: se avisa y se usa memoria.

import { EventEmitter } from "node:events";
import { config } from "../config.js";
import { log } from "../logger.js";

const CHANNEL = "eventos:events";
const RECENT_KEY = "eventos:recent";
const RECENT_CAP = 500;

// Estado del bus
let mode = "memory"; // "connected" | "memory"
const subscribers = new Set();

// ── Fallback en memoria ──────────────────────────────────────────────────
const emitter = new EventEmitter();
emitter.setMaxListeners(0);
const memRecent = []; // más reciente primero

function memPublish(event) {
  memRecent.unshift(event);
  if (memRecent.length > RECENT_CAP) memRecent.length = RECENT_CAP;
  emitter.emit("event", event);
}

function memSave(event) {
  // upsert por id en la lista reciente
  const idx = memRecent.findIndex((e) => e.id === event.id);
  if (idx >= 0) memRecent[idx] = event;
}

function memRecentList(limit = 50) {
  return memRecent.slice(0, limit);
}

// ── Redis (carga perezosa de ioredis) ──────────────────────────────────────
let pub = null;
let sub = null;
let redisReady = false;

async function initRedis() {
  if (!config.redisUrl) {
    log.info("REDIS_URL no definido — usando bus en memoria");
    return;
  }

  let Redis;
  try {
    ({ default: Redis } = await import("ioredis"));
  } catch (err) {
    log.warn(`No se pudo cargar ioredis (${err.message}) — usando bus en memoria`);
    return;
  }

  // No reintentar de forma indefinida: si falla, caemos a memoria.
  const opts = {
    lazyConnect: true,
    maxRetriesPerRequest: 2,
    retryStrategy: (times) => (times > 3 ? null : Math.min(times * 200, 1000)),
    reconnectOnError: () => false,
  };

  try {
    pub = new Redis(config.redisUrl, opts);
    sub = new Redis(config.redisUrl, opts);

    // Manejo de errores: no tirar el proceso
    pub.on("error", (e) => log.warn(`Redis pub error: ${e.message}`));
    sub.on("error", (e) => log.warn(`Redis sub error: ${e.message}`));

    await pub.connect();
    await sub.connect();

    await sub.subscribe(CHANNEL);
    sub.on("message", (ch, msg) => {
      if (ch !== CHANNEL) return;
      try {
        const event = JSON.parse(msg);
        for (const fn of subscribers) fn(event);
      } catch (e) {
        log.warn(`Mensaje de bus inválido: ${e.message}`);
      }
    });

    redisReady = true;
    mode = "connected";
    log.info(`Bus Redis conectado: ${config.redisUrl}`);
  } catch (err) {
    log.warn(`No se pudo conectar a Redis (${err.message}) — usando bus en memoria`);
    redisReady = false;
    mode = "memory";
    try {
      pub?.disconnect();
      sub?.disconnect();
    } catch {}
    pub = null;
    sub = null;
  }
}

// ── API pública del bus ────────────────────────────────────────────────────

// Publica un evento nuevo (fan-out a suscriptores + persistencia en `recent`)
export async function publish(event) {
  if (redisReady && pub) {
    try {
      await pub
        .multi()
        .publish(CHANNEL, JSON.stringify(event))
        .lpush(RECENT_KEY, JSON.stringify(event))
        .ltrim(RECENT_KEY, 0, RECENT_CAP - 1)
        .exec();
      return;
    } catch (err) {
      log.warn(`publish() falló en Redis (${err.message}) — usando memoria`);
    }
  }
  memPublish(event);
}

// Suscribe una función a los eventos del bus. En modo Redis, los eventos llegan
// vía el canal pub/sub; en memoria, vía EventEmitter local.
export function subscribe(fn) {
  subscribers.add(fn);
  if (!redisReady) emitter.on("event", fn);
  return () => {
    subscribers.delete(fn);
    if (!redisReady) emitter.off("event", fn);
  };
}

// Devuelve los N eventos más recientes (para snapshot)
export async function recent(limit = 50) {
  if (redisReady && pub) {
    try {
      const items = await pub.lrange(RECENT_KEY, 0, limit - 1);
      return items.map((s) => JSON.parse(s));
    } catch (err) {
      log.warn(`recent() falló en Redis (${err.message}) — usando memoria`);
    }
  }
  return memRecentList(limit);
}

// Script Lua: busca el evento por id en la lista y reescribe esa posición, TODO de
// forma ATÓMICA (un publish concurrente no puede desplazar el índice entre el
// find y el set, como sí pasaba con lrange+lset desde el cliente).
const SAVE_LUA = `
local key = KEYS[1]
local id = ARGV[1]
local val = ARGV[2]
local items = redis.call('LRANGE', key, 0, -1)
for i = 1, #items do
  local ok, obj = pcall(cjson.decode, items[i])
  if ok and obj and obj.id == id then
    redis.call('LSET', key, i - 1, val)
    return 1
  end
end
return 0
`;

// Upsert de un evento (para reflejar updates de estado en `recent`)
export async function save(event) {
  if (redisReady && pub) {
    try {
      await pub.eval(SAVE_LUA, 1, RECENT_KEY, event.id, JSON.stringify(event));
      return;
    } catch (err) {
      log.warn(`save() falló en Redis (${err.message}) — usando memoria`);
    }
  }
  memSave(event);
}

export function busMode() {
  return mode;
}

export const bus = {
  init: initRedis,
  publish,
  subscribe,
  recent,
  save,
  mode: busMode,
};

export default bus;
