// status.js — muestreo LIVIANO de reachability (online/offline) de todos los
// dispositivos, en memoria. Cada ~60 s hace un TCP connect (sin auth, barato) al
// puerto de gestión (o RTSP de respaldo) de cada equipo y cachea {online, ts}.
// Sirve para el "árbol de recursos" del muro (contadores online/total por sitio)
// sin sondear los equipos en cada request. Nunca tira el server.
import net from "node:net";
import { list as listConfig } from "../config/store.js";
import { log } from "../logger.js";

const SAMPLE_MS = 60 * 1000;   // re-muestrea cada 60 s
const CONCURRENCY = 8;         // conexiones en paralelo (evita ráfaga contra la red)
const _status = new Map();     // id -> { online:boolean, ts:number }

function tcpReachable(host, port, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok) => { if (done) return; done = true; try { sock.destroy(); } catch { /* noop */ } resolve(ok); };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => finish(true));
    sock.once("timeout", () => finish(false));
    sock.once("error", () => finish(false));
    try { sock.connect(port, host); } catch { finish(false); }
  });
}

async function probe(dev) {
  const host = dev.camIp || dev.ip;
  if (!host) return null; // sin dirección → estado desconocido
  const mgmt = Number(dev.isapiPort) || Number(dev.port) || 80;
  const rtsp = Number(dev.rtspPort) || 554;
  // Alcanzable si responde el puerto de gestión O el RTSP.
  if (await tcpReachable(host, mgmt)) return true;
  if (rtsp !== mgmt && (await tcpReachable(host, rtsp))) return true;
  return false;
}

async function sampleAll() {
  let devices = [];
  try { devices = listConfig("devices"); } catch { /* store */ }
  const list = devices.filter((d) => d && d.enabled !== false);
  let i = 0;
  const worker = async () => {
    while (i < list.length) {
      const dev = list[i++];
      try {
        const ok = await probe(dev);
        if (ok === null) { _status.delete(dev.id); }
        else _status.set(dev.id, { online: ok, ts: Date.now() });
      } catch { /* una falla no corta el resto */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, list.length || 1) }, worker));
}

// Estado cacheado de un dispositivo: true/false, o null si aún no se muestreó / sin IP.
export function deviceOnline(id) {
  const s = _status.get(id);
  return s ? s.online : null;
}
// Mapa {id: online} para inyectar en /api/cameras.
export function statusMap() { return _status; }

let started = false;
export function startStatusSampler() {
  if (started) return; started = true;
  const run = () => { sampleAll().catch(() => {}); };
  setTimeout(run, 4000);                    // primera pasada a los 4 s del arranque
  const t = setInterval(run, SAMPLE_MS);    // luego cada 60 s
  if (t.unref) t.unref();
  log.info("status sampler: reachability de dispositivos cada 60 s (online/total del árbol)");
}
