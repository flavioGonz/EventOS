// Retención e histórico de salud de los NVR. Muestrea periódicamente (cada 5 min)
// una foto liviana por ISAPI (online, CPU, memoria, uso de disco, latencia RTT) y la
// persiste en server/data/health-<id>.jsonl. Permite comparar la salud en el tiempo,
// en vez de traer sólo el valor puntual a demanda. Nunca tira el server.
import fs from "node:fs";
import { appendJsonl, readJsonl, dataPath } from "../util/jsonl.js";
import { list as listConfig } from "../config/store.js";
import { digestGetBuffer } from "../util/digestFetch.js";
import { log } from "../logger.js";

const xtag = (xml, t) => { const m = new RegExp(`<${t}>([\\s\\S]*?)</${t}>`, "i").exec(xml || ""); return m ? m[1].trim() : null; };
const fileFor = (id) => `health-${String(id).replace(/[^\w-]/g, "_")}.jsonl`;
const SAMPLE_MS = 5 * 60 * 1000;        // muestra cada 5 min
const KEEP_MS = 7 * 24 * 3600 * 1000;   // retención 7 días

async function sampleOne(nvr) {
  const base = { host: nvr.ip, port: Number(nvr.isapiPort) || 80, https: !!nvr.isapiHttps, user: nvr.username, pass: nvr.password || "" };
  const get = async (p) => {
    try { const r = await digestGetBuffer({ ...base, path: p, timeoutMs: 6000 }); if (r.status === 200 && r.buffer) return r.buffer.toString("utf8"); } catch { /* off */ }
    return null;
  };
  const t0 = Date.now();
  const [di, st, storage] = await Promise.all([
    get("/ISAPI/System/deviceInfo"),
    get("/ISAPI/System/status"),
    get("/ISAPI/ContentMgmt/Storage"),
  ]);
  const rtt = di ? Date.now() - t0 : null;
  const online = !!(di || st || storage);
  let cpu = null, memPct = null, diskPct = null;
  if (st) {
    const c = Number(xtag(st, "cpuUtilization")); if (Number.isFinite(c)) cpu = c;
    const mu = Number(xtag(st, "memoryUsage")); const ma = Number(xtag(st, "memoryAvailable"));
    if (Number.isFinite(mu) && Number.isFinite(ma) && (mu + ma) > 0) memPct = Math.round((mu / (mu + ma)) * 100);
  }
  if (storage && !/<workMode>\s*quota\s*<\/workMode>/i.test(storage)) {
    let cap = 0, free = 0;
    for (const m of storage.matchAll(/<hdd\b[^>]*>([\s\S]*?)<\/hdd>/gi)) { cap += Number(xtag(m[1], "capacity")) || 0; free += Number(xtag(m[1], "freeSpace")) || 0; }
    if (cap > 0) diskPct = Math.round(((cap - free) / cap) * 100);
  }
  return { ts: Date.now(), online, cpu, memPct, diskPct, rtt };
}

function pruneOld(id) {
  try {
    const name = fileFor(id);
    const rows = readJsonl(name);
    if (rows.length < 300) return;
    const cutoff = Date.now() - KEEP_MS;
    const kept = rows.filter((r) => r.ts >= cutoff);
    if (kept.length !== rows.length) fs.writeFileSync(dataPath(name), kept.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  } catch { /* tolerante */ }
}

async function sampleAll() {
  let devices = [];
  try { devices = listConfig("devices"); } catch { /* store */ }
  const nvrs = devices.filter((d) => d && d.type === "nvr");
  for (const nvr of nvrs) {
    try { const s = await sampleOne(nvr); await appendJsonl(fileFor(nvr.id), s); pruneOld(nvr.id); }
    catch { /* una muestra fallida no corta el resto */ }
  }
}

// Lee el histórico de un NVR en la ventana pedida y lo submuestrea a ~120 puntos.
export function readHistory(id, sinceMs) {
  const rows = readJsonl(fileFor(id));
  const since = Date.now() - (sinceMs || 24 * 3600 * 1000);
  let pts = rows.filter((r) => r && r.ts >= since);
  const MAX = 120;
  if (pts.length > MAX) { const step = Math.ceil(pts.length / MAX); pts = pts.filter((_, i) => i % step === 0); }
  return pts;
}

let started = false;
export function startHealthSampler() {
  if (started) return; started = true;
  const run = () => { sampleAll().catch(() => {}); };
  setTimeout(run, 15000);                 // primera muestra a los 15 s del arranque
  const t = setInterval(run, SAMPLE_MS);  // luego cada 5 min
  if (t.unref) t.unref();
  log.info("health sampler: muestreo de salud de NVR cada 5 min (retención 7 días)");
}
