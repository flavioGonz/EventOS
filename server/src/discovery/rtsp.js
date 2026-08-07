// discovery/rtsp.js — Descubridor por RTSP para equipos que NO exponen ISAPI ni
// ONVIF (p. ej. Tiandy). Enumera los canales del NVR probando su RTSP por
// plantilla de fabricante (getVideo().rtspTemplates) con `ffprobe` (DESCRIBE):
// cada canal que devuelve un stream de video se agrega como canal + stream.
import { spawn } from "node:child_process";
import { getVideo } from "../config/store.js";
import { log } from "../logger.js";

// ffprobe de una URL RTSP: devuelve la línea de datos del stream de video, o null.
function ffprobeRtsp(url, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const args = [
      "-v", "error", "-rtsp_transport", "tcp",
      "-select_streams", "v:0",
      "-show_entries", "stream=codec_name,width,height",
      "-of", "default=nw=1",
      "-rw_timeout", String(timeoutMs * 1000),
      "-i", url,
    ];
    let out = ""; let done = false;
    let p;
    const finish = (val) => { if (done) return; done = true; clearTimeout(timer); try { p && p.kill("SIGKILL"); } catch { /* noop */ } resolve(val); };
    const timer = setTimeout(() => finish(null), timeoutMs + 800);
    try { p = spawn("ffprobe", args); } catch { return finish(null); }
    p.stdout.on("data", (d) => { out += d.toString(); });
    p.on("close", (code) => finish(code === 0 && /codec_name=/.test(out) ? out : null));
    p.on("error", () => finish(null));
  });
}

function templateFor(vendor) {
  const v = String(vendor || "").trim().toLowerCase();
  try {
    const hit = (getVideo().rtspTemplates || []).find((t) => String(t.vendor || "").trim().toLowerCase() === v);
    if (hit && (hit.main || hit.sub)) return hit;
  } catch { /* store */ }
  return { main: "/{ch}/1", sub: "/{ch}/2" }; // por defecto tipo Tiandy
}

// Enumera canales 1..maxCh probando el RTSP main de cada uno. Corta tras
// `maxMiss` canales consecutivos sin respuesta (los NVR suelen ser contiguos).
export async function discover({ host, port, user, pass, vendor, rtspPort, maxCh = 16, maxMiss = 4 }) {
  const rp = Number(rtspPort) || Number(port) || 554;
  const out = {
    host, port: rp,
    device: { name: vendor ? `${vendor} NVR` : "NVR/RTSP", model: vendor || null, deviceType: "NVR (RTSP)", firmware: null, serial: null, mac: null },
    channels: [], streams: [], analytics: [], outputs: [], errors: [],
  };
  const tpl = templateFor(vendor);
  const u = encodeURIComponent(user || "");
  const pw = encodeURIComponent(pass || "");
  let miss = 0;
  for (let ch = 1; ch <= maxCh && miss < maxMiss; ch++) {
    const path = (tpl.main || "/{ch}/1").replace(/\{ch\}/g, String(ch));
    const url = `rtsp://${u}:${pw}@${host}:${rp}${path}`;
    const r = await ffprobeRtsp(url);
    if (r) {
      miss = 0;
      const codec = (r.match(/codec_name=(\w+)/) || [])[1] || null;
      const w = (r.match(/width=(\d+)/) || [])[1];
      const h = (r.match(/height=(\d+)/) || [])[1];
      out.channels.push({ id: ch, name: `Canal ${ch}`, ip: host, online: true });
      out.streams.push({ id: ch * 100 + 1, rtsp: url, codec, resolution: w && h ? `${w}x${h}` : null });
    } else {
      miss++;
    }
  }
  if (!out.channels.length) {
    out.errors.push("Ningún canal respondió por RTSP. Revisá usuario/clave y el puerto RTSP (554), y que la plantilla RTSP del fabricante sea correcta.");
    out.device = null; // sin canales → tratamos como fallo de descubrimiento
  } else {
    log.info(`discover[rtsp]: ${host}:${rp} (${vendor || '—'}) → ${out.channels.length} canal(es)`);
  }
  return out;
}

export default { discover };
