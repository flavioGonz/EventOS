// playback/hls.js — sesiones de transcodificación RTSP → HLS con ffmpeg.
// El navegador no reproduce RTSP; ffmpeg saca el stream del NVR (live o playback
// por tiempo) y lo segmenta a HLS, que se sirve por HTTP y se reproduce con hls.js.
// Seguridad: spawn con array de args (sin shell → sin inyección); límite de
// sesiones concurrentes (CPU); TTL con limpieza; la URL la construye el server.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { log } from "../logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLAYBACK_DIR = path.resolve(__dirname, "..", "..", "data", "playback");
// Sesiones concurrentes máximas. Configurable (EVENTOS_MAX_HLS). El vivo ahora
// RE-ENCODA (libx264) para sanear el SPS roto de estas cámaras → más CPU que un
// remux copy, así que el tope es más bajo. El muro usa snapshots (no abre vivos);
// los vivos reales son el modal (1-2) y algún hero del popup.
const MAX_SESSIONS = Math.max(2, Number(process.env.EVENTOS_MAX_HLS) || 10);
const SESSION_TTL_MS = 5 * 60 * 1000;

const sessions = new Map(); // id → { proc, dir, timer, key }
const byKey = new Map();    // key → id (reúso de sesiones de vivo)

function destroy(id) {
  const s = sessions.get(id);
  if (!s) return;
  try { s.proc && s.proc.kill("SIGKILL"); } catch { /* ya muerto */ }
  try { clearTimeout(s.timer); } catch {}
  try { fs.rmSync(s.dir, { recursive: true, force: true }); } catch {}
  if (s.key && byKey.get(s.key) === id) byKey.delete(s.key);
  sessions.delete(id);
}

function touch(id) {
  const s = sessions.get(id);
  if (!s) return;
  try { clearTimeout(s.timer); } catch {}
  s.timer = setTimeout(() => destroy(id), SESSION_TTL_MS);
  s.timer.unref && s.timer.unref();
}

// Arranca (o reúsa, si se pasa `key`) una sesión HLS desde una URL RTSP que el
// server ya construyó. El reúso evita duplicar ffmpeg cuando varios ven la misma
// cámara en vivo.
export function startHls(rtspUrl, opts = {}) {
  if (typeof rtspUrl !== "string" || !/^rtsps?:\/\//i.test(rtspUrl)) {
    throw new Error("URL RTSP inválida");
  }
  const key = opts.key ? String(opts.key) : null;
  if (key && byKey.has(key)) {
    const exId = byKey.get(key);
    if (sessions.has(exId)) { touch(exId); return { id: exId, dir: sessions.get(exId).dir, url: `/api/playback/${exId}/index.m3u8`, reused: true }; }
    byKey.delete(key);
  }
  if (sessions.size >= MAX_SESSIONS) destroy([...sessions.keys()][0]); // expulsa la más vieja
  const id = randomUUID().replace(/-/g, "").slice(0, 12);
  const dir = path.join(PLAYBACK_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  const args = [
    "-nostdin",                     // no leer stdin (evita que ffmpeg se cuelgue)
    "-rtsp_transport", opts.transport === "udp" ? "udp" : "tcp",
    // Las cámaras Hik mandan paquetes SIN timestamps → el muxer HLS aborta
    // ("first pts and dts must be set"). Asignar reloj de pared lo resuelve y
    // mantiene ffmpeg vivo (stream continuo). CLAVE para vivo y playback.
    "-use_wallclock_as_timestamps", "1",
    // (sin opción de timeout: este ffmpeg 5.1 no acepta 'stimeout'/'rw_timeout';
    //  el TTL de sesión y el manejo de error del cliente cubren conexiones colgadas)
    "-i", rtspUrl,
    "-an",                          // sin audio
    // Las cámaras fisheye de cesimco emiten un H264 con SPS malformado (crop values
    // invalid / sps_id out of range) que NINGÚN navegador decodifica con `copy`
    // (PIPELINE_ERROR_DECODE). RE-ENCODAR con libx264 reescribe un SPS válido →
    // reproduce limpio. ffmpeg tolera y recupera el stream de entrada corrupto.
    // `copy` (remux) se conserva para fuentes sanas vía opts.transcode=false.
    ...(opts.transcode === false
      ? ["-c:v", "copy", "-bsf:v", "dump_extra=freq=keyframe"]
      : ["-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency",
         "-profile:v", "baseline", "-pix_fmt", "yuv420p", "-g", "50", "-sc_threshold", "0"]),
    "-f", "hls",
    "-hls_time", "2",
    "-hls_list_size", "8",
    "-hls_flags", "delete_segments+append_list+omit_endlist+independent_segments",
    "-hls_segment_filename", path.join(dir, "seg_%03d.ts"),
    path.join(dir, "index.m3u8"),
  ];
  const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
  let errTail = "";
  proc.stderr.on("data", (d) => { errTail = (errTail + d.toString()).slice(-1500); });
  proc.on("error", (e) => { log.warn(`ffmpeg no se pudo lanzar (${e.message})`); destroy(id); });
  proc.on("exit", (code) => {
    if (code && code !== 255) log.warn(`ffmpeg playback ${id} salió ${code}: ${errTail.slice(-250)}`);
  });
  const timer = setTimeout(() => destroy(id), SESSION_TTL_MS);
  timer.unref && timer.unref();
  sessions.set(id, { proc, dir, timer, key });
  if (key) byKey.set(key, id);
  return { id, dir, url: `/api/playback/${id}/index.m3u8` };
}

// Mantiene viva una sesión (reinicia su TTL). Para "heartbeat" de tiles en vivo.
export function keepAlive(id) { if (sessions.has(String(id))) { touch(String(id)); return true; } return false; }

// Devuelve la ruta de un archivo de la sesión (m3u8/ts) o null. Anti path-traversal.
export function sessionFile(id, file) {
  const s = sessions.get(String(id));
  if (!s) return null;
  if (!/^[\w.-]+\.(m3u8|ts)$/.test(String(file))) return null;
  const fp = path.join(s.dir, file);
  if (!fp.startsWith(s.dir + path.sep)) return null;
  return fp;
}

export function stopHls(id) { destroy(String(id)); }

// Limpieza al apagar.
process.once("SIGTERM", () => { for (const id of [...sessions.keys()]) destroy(id); });
process.once("SIGINT", () => { for (const id of [...sessions.keys()]) destroy(id); });

export default { startHls, sessionFile, stopHls };
