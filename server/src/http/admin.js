// admin.js — API de administración /api/admin/* (CONTRACT-V2 §2)
//
// Auth: header X-Admin-Token === config.adminToken. Si adminToken no está definido,
// las rutas quedan abiertas (modo dev). 401 si hay token configurado y no coincide.
// Toda mutación persiste en el store (config/store.js) y aplica en vivo: el motor de
// reglas y el de dispatch leen siempre del store.
import { Router } from "express";
import { config, tokensEqual } from "../config.js";
import { log } from "../logger.js";
import * as store from "../config/store.js";
import { readJsonl } from "../util/jsonl.js";
import { listOperators } from "../dispatch/store.js";
import { discover as discoverHik } from "../discovery/hikvision.js";
import { discover as discoverOnvif } from "../discovery/onvif.js";
import { digestGetBuffer } from "../util/digestFetch.js";
import { ingestRaw } from "../dispatch/pipeline.js";

const router = Router();

// ── Auth ─────────────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (!config.adminToken) return next(); // modo dev: abierto
  const token = req.get("X-Admin-Token");
  if (!tokensEqual(token, config.adminToken)) {
    return res.status(401).json({ error: "unauthorized", message: "X-Admin-Token inválido" });
  }
  next();
}
router.use(requireAdmin);

// ── Ping (para el login del panel) ──────────────────────────────────────────
router.post("/ping", (req, res) => {
  res.json({ ok: true, auth: config.adminToken ? "token" : "open" });
});

// ── Descubrimiento de equipos (ISAPI Hikvision) ──────────────────────────────
// Admin-only. Sondea un NVR/cámara (host+credenciales) y devuelve info, canales,
// analíticas y streams. El SSRF queda mitigado por el gate de admin.
router.post("/discover", async (req, res) => {
  const { host, port, user, pass, https, protocol } = req.body || {};
  if (!host || !user) return res.status(400).json({ error: "bad_request", message: "host y usuario son requeridos" });
  const proto = protocol === "onvif" ? "onvif" : "hikvision";
  const discover = proto === "onvif" ? discoverOnvif : discoverHik;
  try {
    const result = await discover({ host, port, user, pass, https });
    log.info(`discover[${proto}]: ${host} → ${result.channels.length} canales, ${result.analytics.length} analíticas`);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: "discover_failed", message: e.message });
  }
});

// ── Prueba de alerta de un dispositivo ──────────────────────────────────────
// Inyecta un evento SINTÉTICO por el pipeline real (normalize→reglas→bus→socket)
// para verificar de punta a punta que el dispositivo alerta y llega a la consola.
// Salta la política de alertado del propio dispositivo (opts.test) para que
// SIEMPRE aparezca, aunque su config lo filtrara.
router.post("/devices/:id/test-alert", async (req, res) => {
  const dev = store.get("devices", req.params.id);
  if (!dev) return res.status(404).json({ error: "no_device" });
  let siteName = null;
  try { const s = store.list("sites").find((x) => x.id === dev.siteId); siteName = s && s.name; } catch { /* store */ }
  let vendor, raw;
  if (dev.type === "alarm") {
    vendor = "alarm";
    raw = { type: "intrusion", panelId: dev.id, panelName: `PRUEBA · ${dev.name}`, zone: dev.channel || 1, zoneName: "PRUEBA", site: siteName || dev.name };
  } else {
    vendor = "hikvision";
    raw = { eventType: "linedetection", deviceId: dev.id, deviceName: `PRUEBA · ${dev.name}`, channelID: dev.channel || 1, ipAddress: dev.ip, site: siteName || "Prueba", targetType: "human", dateTime: new Date().toISOString() };
  }
  try {
    const event = await ingestRaw(vendor, raw, { test: true });
    log.info(`test-alert: ${dev.name} → evento ${event.id} (P${event.priority})`);
    res.json({ ok: true, eventId: event.id, priority: event.priority, type: event.type });
  } catch (e) {
    res.status(500).json({ error: "test_failed", message: e.message });
  }
});

// ── Documento completo ──────────────────────────────────────────────────────
router.get("/config", (req, res) => {
  res.json(store.getConfig());
});

// ── CRUD genérico por colección ─────────────────────────────────────────────
// Colecciones array: devices, sites, operators, rules, procedures.
const COLLECTIONS = ["devices", "sites", "operators", "groups", "rules", "procedures"];

for (const name of COLLECTIONS) {
  // Listar
  router.get(`/${name}`, (req, res) => {
    res.json({ [name]: store.list(name) });
  });

  // Crear
  router.post(`/${name}`, (req, res) => {
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return res.status(400).json({ error: "bad_request", message: "cuerpo JSON requerido" });
    }
    try {
      const item = store.create(name, body);
      log.info(`admin: ${name} creado ${item.id}`);
      res.status(201).json(item);
    } catch (e) {
      res.status(400).json({ error: "create_failed", message: e.message });
    }
  });

  // Obtener uno (deja pasar rutas con nombre reservado como /operators/stats)
  router.get(`/${name}/:id`, (req, res, next) => {
    if (req.params.id === "stats") return next();
    const item = store.get(name, req.params.id);
    if (!item) return res.status(404).json({ error: "not_found" });
    res.json(item);
  });

  // Editar
  router.put(`/${name}/:id`, (req, res) => {
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return res.status(400).json({ error: "bad_request", message: "cuerpo JSON requerido" });
    }
    const item = store.update(name, req.params.id, body);
    if (!item) return res.status(404).json({ error: "not_found" });
    log.info(`admin: ${name} actualizado ${item.id}`);
    res.json(item);
  });

  // Borrar
  router.delete(`/${name}/:id`, (req, res) => {
    const ok = store.remove(name, req.params.id);
    if (!ok) return res.status(404).json({ error: "not_found" });
    log.info(`admin: ${name} borrado ${req.params.id}`);
    res.json({ ok: true, id: req.params.id });
  });
}

// ── Dispatch (objeto, no array) ──────────────────────────────────────────────
const DISPATCH_MODES = ["simultaneous", "sequential", "rules"];
const SEQ_STRATEGIES = ["round_robin", "least_loaded"];

router.get("/dispatch", (req, res) => {
  res.json(store.getDispatch());
});

router.put("/dispatch", (req, res) => {
  const body = req.body || {};
  const patch = {};
  if (body.mode !== undefined) {
    if (!DISPATCH_MODES.includes(body.mode)) {
      return res.status(400).json({ error: "bad_request", message: `mode inválido (${DISPATCH_MODES.join("|")})` });
    }
    patch.mode = body.mode;
  }
  if (body.sequentialStrategy !== undefined) {
    if (!SEQ_STRATEGIES.includes(body.sequentialStrategy)) {
      return res.status(400).json({ error: "bad_request", message: `sequentialStrategy inválido (${SEQ_STRATEGIES.join("|")})` });
    }
    patch.sequentialStrategy = body.sequentialStrategy;
  }
  if (body.ackTimeoutSeconds !== undefined) patch.ackTimeoutSeconds = Math.max(0, Number(body.ackTimeoutSeconds) || 0);
  if (body.reassignOnTimeout !== undefined) patch.reassignOnTimeout = !!body.reassignOnTimeout;
  if (body.maxConcurrentPerOperator !== undefined) patch.maxConcurrentPerOperator = Math.max(1, Number(body.maxConcurrentPerOperator) || 1);
  if (body.skillRouting !== undefined) patch.skillRouting = !!body.skillRouting;

  const updated = store.setDispatch(patch);
  log.info(`admin: dispatch actualizado (mode=${updated.mode})`);
  res.json(updated);
});

// ── Salud de NVR/DVR (ISAPI: uptime, CPU, RAM, discos) ───────────────────────
const xtag = (xml, t) => { const m = new RegExp(`<${t}>([\\s\\S]*?)</${t}>`, "i").exec(xml || ""); return m ? m[1].trim() : null; };
async function nvrHealth(dev) {
  const out = { id: dev.id, name: dev.name, ip: dev.ip, online: false, model: null, firmware: null,
    uptime: null, cpu: null, memUsed: null, memTotal: null, hdds: [] };
  const get = async (path) => {
    try {
      const r = await digestGetBuffer({ host: dev.ip, port: Number(dev.isapiPort), https: !!dev.isapiHttps,
        path, user: dev.username, pass: dev.password || "", timeoutMs: 6000 });
      if (r.status === 200 && r.buffer) return r.buffer.toString("utf8");
    } catch { /* offline */ }
    return null;
  };
  const di = await get("/ISAPI/System/deviceInfo");
  if (di) { out.online = true; out.model = xtag(di, "model"); out.firmware = xtag(di, "firmwareVersion"); out.name = xtag(di, "deviceName") || out.name; }
  const st = await get("/ISAPI/System/status");
  if (st) {
    out.online = true;
    const up = Number(xtag(st, "deviceUpTime")); if (Number.isFinite(up)) out.uptime = up;
    const cpu = Number(xtag(st, "cpuUtilization")); if (Number.isFinite(cpu)) out.cpu = cpu;
    const mu = Number(xtag(st, "memoryUsage")); const ma = Number(xtag(st, "memoryAvailable"));
    if (Number.isFinite(mu)) out.memUsed = mu;
    if (Number.isFinite(mu) && Number.isFinite(ma)) out.memTotal = mu + ma;
  }
  const storage = await get("/ISAPI/ContentMgmt/Storage");
  if (storage) {
    out.hdds = [...storage.matchAll(/<hdd>([\s\S]*?)<\/hdd>/gi)].map((m) => ({
      name: xtag(m[1], "hddName"), status: xtag(m[1], "status"),
      capacity: Number(xtag(m[1], "capacity")) || 0, free: Number(xtag(m[1], "freeSpace")) || 0,
    }));
  }
  return out;
}
router.get("/nvr-health", async (req, res) => {
  let devices = [];
  try { devices = store.list("devices"); } catch { /* store */ }
  const nvrs = devices.filter((d) => d.type === "nvr" && d.ip && d.isapiPort && d.username);
  const nvrsHealth = await Promise.all(nvrs.map(nvrHealth));
  res.json({ nvrs: nvrsHealth });
});

// ── Ajustes de video en vivo / RTSP ──────────────────────────────────────────
const LIVE_MODES = ["mjpeg", "hls"];
const VIDEO_QUALITIES = ["sub", "main"];
const RTSP_TRANSPORTS = ["tcp", "udp"];
// Evidencia: retencion (dias + maximo de archivos).
router.get("/evidence", (req, res) => {
  res.json(store.getEvidence());
});
router.put("/evidence", (req, res) => {
  const b = req.body || {};
  const patch = {};
  if (b.retentionDays !== undefined) patch.retentionDays = Math.max(0, Math.min(3650, Number(b.retentionDays) || 0));
  if (b.maxFiles !== undefined) patch.maxFiles = Math.max(0, Number(b.maxFiles) || 0);
  const updated = store.setEvidence(patch);
  log.info(`admin: retencion de evidencia (dias=${updated.retentionDays} max=${updated.maxFiles})`);
  res.json(updated);
});
router.get("/video", (req, res) => {
  res.json(store.getVideo());
});
router.put("/video", (req, res) => {
  const body = req.body || {};
  const patch = {};
  if (body.liveMode !== undefined) {
    if (!LIVE_MODES.includes(body.liveMode)) return res.status(400).json({ error: "bad_request", message: `liveMode inválido (${LIVE_MODES.join("|")})` });
    patch.liveMode = body.liveMode;
  }
  if (body.quality !== undefined) {
    if (!VIDEO_QUALITIES.includes(body.quality)) return res.status(400).json({ error: "bad_request", message: `quality inválido (${VIDEO_QUALITIES.join("|")})` });
    patch.quality = body.quality;
  }
  if (body.rtspTransport !== undefined) {
    if (!RTSP_TRANSPORTS.includes(body.rtspTransport)) return res.status(400).json({ error: "bad_request", message: `rtspTransport inválido` });
    patch.rtspTransport = body.rtspTransport;
  }
  if (body.mjpegConcurrency !== undefined) patch.mjpegConcurrency = Math.min(16, Math.max(1, Number(body.mjpegConcurrency) || 6));
  if (Array.isArray(body.rtspTemplates)) {
    patch.rtspTemplates = body.rtspTemplates
      .filter((t) => t && t.vendor)
      .map((t) => ({ vendor: String(t.vendor).slice(0, 40), main: String(t.main || "").slice(0, 200), sub: String(t.sub || "").slice(0, 200) }))
      .slice(0, 20);
  }
  const updated = store.setVideo(patch);
  log.info(`admin: video actualizado (modo=${updated.liveMode} calidad=${updated.quality})`);
  res.json(updated);
});

// ── Recepción: token de ingesta + URLs de webhook ────────────────────────────
router.get("/reception", (req, res) => {
  // Base pública: respeta proxy (nginx) si manda X-Forwarded-*
  const proto = req.get("X-Forwarded-Proto") || req.protocol;
  const host = req.get("X-Forwarded-Host") || req.get("Host") || `127.0.0.1:${config.port}`;
  const base = `${proto}://${host}`;
  const token = config.ingestToken;

  const endpoints = ["hikvision", "akuvox", "nvr", "alarm", "generic"].map((vendor) => ({
    vendor,
    url: `${base}/api/ingest/${vendor}`,
    urlWithToken: `${base}/api/ingest/${vendor}?token=${token}`,
    header: { "X-Ingest-Token": token },
  }));

  // URLs por dispositivo (el endpoint depende del type del dispositivo)
  const devices = store.list("devices").map((d) => {
    const vendor = ["hikvision", "akuvox", "nvr", "alarm", "generic"].includes(d.type) ? d.type : "generic";
    return {
      id: d.id,
      name: d.name,
      type: d.type,
      enabled: d.enabled,
      url: `${base}/api/ingest/${vendor}`,
      urlWithToken: `${base}/api/ingest/${vendor}?token=${token}`,
    };
  });

  res.json({ ingestToken: token, base, endpoints, devices });
});

// ── Estadísticas de operadores (CONTRACT-V3 §1) ──────────────────────────────
// Agrega server/data/operator-log.jsonl en el rango [from,to] → por operario:
//   { msAvailable, msPaused, pauseByReason{}, handled, avgHandleMs }
// El log es una secuencia de eventos login/pause/resume/logout/handled con ms.
// Tolerante a archivo ausente: cae al snapshot en memoria (listOperators()).
router.get("/operators/stats", (req, res) => {
  const fromMs = req.query.from ? Date.parse(req.query.from) : NaN;
  const toMs = req.query.to ? Date.parse(req.query.to) : NaN;
  const inRange = (ts) => {
    const t = Date.parse(ts);
    if (Number.isNaN(t)) return false;
    if (!Number.isNaN(fromMs) && t < fromMs) return false;
    if (!Number.isNaN(toMs) && t > toMs) return false;
    return true;
  };

  const rows = readJsonl("operator-log.jsonl");

  // Acumuladores por operario
  const byOp = new Map();
  const ensure = (id, name) => {
    let o = byOp.get(id);
    if (!o) {
      o = {
        operatorId: id,
        name: name || id,
        msAvailable: 0,
        msPaused: 0,
        pauseByReason: {},
        handled: 0,
        handleMsTotal: 0,
        handleMsCount: 0,
      };
      byOp.set(id, o);
    }
    if (name) o.name = name;
    return o;
  };

  for (const r of rows) {
    if (!r || !r.operatorId) continue;
    if (!inRange(r.ts)) continue;
    const o = ensure(r.operatorId, r.name);
    const ms = Number(r.ms) || 0;
    switch (r.event) {
      case "resume": // ms = duración de la pausa que terminó
        o.msPaused += ms;
        if (r.reason) o.pauseByReason[r.reason] = (o.pauseByReason[r.reason] || 0) + ms;
        break;
      case "logout": // ms = tiempo disponible acumulado de la sesión
        o.msAvailable += ms;
        break;
      case "handled":
        o.handled += 1;
        if (ms > 0) {
          o.handleMsTotal += ms;
          o.handleMsCount += 1;
        }
        break;
      default: // login / pause → marcadores, sin acumular tiempo aquí
        break;
    }
  }

  let operators = [...byOp.values()].map((o) => ({
    operatorId: o.operatorId,
    name: o.name,
    msAvailable: Math.round(o.msAvailable),
    msPaused: Math.round(o.msPaused),
    pauseByReason: o.pauseByReason,
    handled: o.handled,
    avgHandleMs: o.handleMsCount ? Math.round(o.handleMsTotal / o.handleMsCount) : 0,
  }));

  // Respaldo: si no hay log (archivo ausente/vacío), usar el snapshot en memoria.
  if (operators.length === 0) {
    operators = listOperators().map((op) => ({
      operatorId: op.id,
      name: op.name,
      msAvailable: Math.round(op.msAvailable || 0),
      msPaused: Math.round(op.msPaused || 0),
      pauseByReason: {},
      handled: op.handled || 0,
      avgHandleMs: 0,
    }));
  }

  res.json({ from: req.query.from || null, to: req.query.to || null, operators });
});

// ── Analítica de flujo (CONTRACT-V3 §3) ──────────────────────────────────────
// Lee server/data/events.jsonl, filtra por rango+filtros, agrupa en buckets de
// tiempo y por la dimensión `groupBy`. Tolerante a archivo ausente.

const BUCKETS = { minute: 60_000, hour: 3_600_000, day: 86_400_000 };
const GROUP_DIMS = ["priority", "type", "category", "vendor", "site", "target"];
const PRIORITY_LABELS = { 1: "Crítico", 2: "Alto", 3: "Medio", 4: "Bajo", 5: "Info" };

// Trunca un timestamp (ms) al inicio del bucket. Para "day" usa UTC (medianoche).
function bucketStart(ms, bucket) {
  if (bucket === "day") {
    const d = new Date(ms);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  }
  const size = BUCKETS[bucket];
  return Math.floor(ms / size) * size;
}

// Etiqueta legible (español) para una clave de serie según la dimensión.
function seriesLabel(groupBy, key) {
  if (groupBy === "priority") return PRIORITY_LABELS[key] || `P${key}`;
  return key === "—" ? "(sin dato)" : String(key);
}

router.get("/analytics/flow", (req, res) => {
  const bucket = BUCKETS[req.query.bucket] ? req.query.bucket : "hour";
  const groupBy = GROUP_DIMS.includes(req.query.groupBy) ? req.query.groupBy : "priority";

  const rows = readJsonl("events.jsonl");

  // Rango: si no se da, derivar de los datos disponibles (o vacío).
  let fromMs = req.query.from ? Date.parse(req.query.from) : NaN;
  let toMs = req.query.to ? Date.parse(req.query.to) : NaN;

  // Filtros opcionales (igualdad exacta; site/vendor case-insensitive).
  const fSite = req.query.site ? String(req.query.site).toLowerCase() : null;
  const fType = req.query.type ? String(req.query.type) : null;
  const fVendor = req.query.vendor ? String(req.query.vendor).toLowerCase() : null;
  const fPriority = req.query.priority != null && req.query.priority !== "" ? String(req.query.priority) : null;
  const fTarget = req.query.target ? String(req.query.target) : null;

  // Normaliza una fila a campos comparables.
  const norm = (r) => ({
    ms: Date.parse(r.ts),
    type: r.type ?? "—",
    category: r.category ?? "—",
    priority: r.priority != null ? String(r.priority) : "—",
    vendor: r.vendor ?? "—",
    site: r.site ?? "—",
    status: r.status ?? "—",
    target: r.target ?? "—",
  });

  // Filtrado por rango + filtros.
  const matched = [];
  for (const raw of rows) {
    const r = norm(raw);
    if (Number.isNaN(r.ms)) continue;
    if (!Number.isNaN(fromMs) && r.ms < fromMs) continue;
    if (!Number.isNaN(toMs) && r.ms > toMs) continue;
    if (fSite && String(r.site).toLowerCase() !== fSite) continue;
    if (fType && r.type !== fType) continue;
    if (fVendor && String(r.vendor).toLowerCase() !== fVendor) continue;
    if (fPriority && r.priority !== fPriority) continue;
    if (fTarget && r.target !== fTarget) continue;
    matched.push(r);
  }

  // Si no hay rango explícito, derivarlo del min/max de los datos filtrados.
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) {
    if (matched.length) {
      let lo = Infinity, hi = -Infinity;
      for (const r of matched) { if (r.ms < lo) lo = r.ms; if (r.ms > hi) hi = r.ms; }
      if (Number.isNaN(fromMs)) fromMs = lo;
      if (Number.isNaN(toMs)) toMs = hi;
    } else {
      // Sin datos: respuesta vacía coherente.
      return res.json({
        from: req.query.from || null,
        to: req.query.to || null,
        bucket,
        groupBy,
        buckets: [],
        series: [],
        total: 0,
        byPriority: {},
        byType: {},
        bySite: {},
        byVendor: {},
      });
    }
  }

  // Eje de tiempo: buckets desde fromMs hasta toMs (inclusive).
  const startB = bucketStart(fromMs, bucket);
  const endB = bucketStart(toMs, bucket);
  const size = BUCKETS[bucket];
  const buckets = [];
  const bucketIndex = new Map();
  if (bucket === "day") {
    for (let t = startB; t <= endB; t += BUCKETS.day) {
      bucketIndex.set(t, buckets.length);
      buckets.push(new Date(t).toISOString());
    }
  } else {
    for (let t = startB; t <= endB; t += size) {
      bucketIndex.set(t, buckets.length);
      buckets.push(new Date(t).toISOString());
    }
  }

  // Series por clave de groupBy: cada una con un array de conteos por bucket.
  const seriesMap = new Map();
  const ensureSeries = (key) => {
    let s = seriesMap.get(key);
    if (!s) {
      s = { key: String(key), label: seriesLabel(groupBy, key), total: 0, values: new Array(buckets.length).fill(0) };
      seriesMap.set(key, s);
    }
    return s;
  };

  // Totales agregados para KPIs/filtros.
  const byPriority = {}, byType = {}, bySite = {}, byVendor = {};
  let total = 0;

  for (const r of matched) {
    const bs = bucketStart(r.ms, bucket);
    const idx = bucketIndex.get(bs);
    if (idx === undefined) continue; // fuera del eje (defensivo)
    const key = r[groupBy];
    const s = ensureSeries(key);
    s.values[idx] += 1;
    s.total += 1;
    total += 1;
    byPriority[r.priority] = (byPriority[r.priority] || 0) + 1;
    byType[r.type] = (byType[r.type] || 0) + 1;
    bySite[r.site] = (bySite[r.site] || 0) + 1;
    byVendor[r.vendor] = (byVendor[r.vendor] || 0) + 1;
  }

  // Series ordenadas por total desc (las más relevantes primero).
  const series = [...seriesMap.values()].sort((a, b) => b.total - a.total);

  res.json({
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    bucket,
    groupBy,
    buckets,
    series,
    total,
    byPriority,
    byType,
    bySite,
    byVendor,
  });
});

export default router;
