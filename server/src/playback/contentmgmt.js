// playback/contentmgmt.js — playback de grabaciones Hikvision vía ISAPI ContentMgmt.
//
// El restream RTSP del NVR de grabaciones H.264+/SmartCodec es indecodificable
// (SPS/PPS rotos al unirse mid-GOP → "sps_id out of range"). PERO el DOWNLOAD HTTP
// de ISAPI entrega el archivo como MPEG Program Stream con los parameter sets
// intactos → decodifica LIMPIO (ffmpeg copy). Verificado contra DS-9632NI-I16.
//
// Gotchas de estos NVR (cada uno daba badXmlContent / "two root tags"):
//  - El `searchID` del search DEBE ser un GUID con guiones (crypto.randomUUID()).
//  - El handshake digest debe SONDEAR SIN cuerpo: si se manda el body en el
//    request 401, el NVR lo concatena con el autenticado → "two root tags".
//    Por eso acá: GET probe (sin body) → nonce → POST con body UNA vez.
//  - El NVR graba SOLO el stream principal → trackID = canal*100 + 1.
import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import { log } from "../logger.js";

const md5 = (s) => crypto.createHash("md5").update(s).digest("hex");

function parseWA(h) {
  const o = {};
  (h || "").replace(/(\w+)=(?:"([^"]*)"|([^,\s]*))/g, (_, k, a, b) => { o[k] = a !== undefined ? a : b; return ""; });
  return o;
}
function authHeader({ user, pass, wa, method, uri }) {
  const cnonce = crypto.randomBytes(8).toString("hex");
  const nc = "00000001";
  const ha1 = md5(`${user}:${wa.realm}:${pass}`);
  const ha2 = md5(`${method}:${uri}`);
  const qop = (wa.qop || "auth").split(",")[0];
  const resp = md5(`${ha1}:${wa.nonce}:${nc}:${cnonce}:${qop}:${ha2}`);
  let h = `Digest username="${user}", realm="${wa.realm}", nonce="${wa.nonce}", uri="${uri}", response="${resp}", qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
  if (wa.opaque) h += `, opaque="${wa.opaque}"`;
  return h;
}
function devBase(dev) {
  return { host: dev.ip, port: Number(dev.isapiPort), secure: !!dev.isapiHttps, user: dev.username, pass: dev.password || "" };
}
function lib(secure) { return secure ? https : http; }

// Probe GET (sin cuerpo) → devuelve el challenge digest (o {} si no hay auth).
function probe(base, path) {
  return new Promise((resolve) => {
    const req = lib(base.secure).request(
      { host: base.host, port: base.port, path: path.split("?")[0], method: "GET", headers: { Connection: "close" }, agent: false, rejectUnauthorized: false },
      (res) => { res.resume(); resolve(parseWA(res.headers["www-authenticate"])); }
    );
    req.on("error", () => resolve({}));
    req.setTimeout(8000, () => { try { req.destroy(); } catch { /* noop */ } resolve({}); });
    req.end();
  });
}

// POST/GET autenticado que junta el texto de respuesta (para search).
async function authedText(dev, method, path, body) {
  const base = devBase(dev);
  const wa = await probe(base, path);
  const auth = authHeader({ user: base.user, pass: base.pass, wa, method, uri: path });
  return await new Promise((resolve) => {
    const headers = { Authorization: auth, Connection: "close" };
    if (body) { headers["Content-Type"] = "application/xml"; headers["Content-Length"] = Buffer.byteLength(body); }
    const req = lib(base.secure).request(
      { host: base.host, port: base.port, path, method, headers, agent: false, rejectUnauthorized: false },
      (res) => { let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve({ status: res.statusCode, text: d })); }
    );
    req.on("error", (e) => resolve({ status: 0, text: String(e.message) }));
    req.setTimeout(12000, () => { try { req.destroy(); } catch { /* noop */ } resolve({ status: 0, text: "timeout" }); });
    if (body) req.write(body);
    req.end();
  });
}

const COMPACT = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;
export function compactToMs(c) {
  const m = COMPACT.exec(String(c || ""));
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}
const toISO = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");

// Offset (ms) entre UTC y la hora LOCAL del NVR. Las grabaciones Hik se etiquetan
// en hora local (con `Z` engañoso); para buscar/descargar hay que enviar el
// reloj LOCAL, no UTC. localMs = utcMs + offset. Cacheado por equipo.
const tzCache = new Map();
export async function deviceTimeOffsetMs(dev) {
  const key = `${dev.ip}:${dev.isapiPort}`;
  if (tzCache.has(key)) return tzCache.get(key);
  let off = 0;
  try {
    const r = await authedText(dev, "GET", "/ISAPI/System/time");
    const m = /<localTime>[^<]*?([+-])(\d{2}):(\d{2})<\/localTime>/.exec(r.text || "");
    if (m) { const sign = m[1] === "-" ? -1 : 1; off = sign * (Number(m[2]) * 60 + Number(m[3])) * 60000; }
  } catch { /* fallback: UTC */ }
  tzCache.set(key, off);
  return off;
}

// Busca el segmento grabado que cubre `startMs` para el track. null si no hay.
export async function searchSegment(dev, trackId, startMs, endMs) {
  const sx =
    `<CMSearchDescription><searchID>${crypto.randomUUID()}</searchID>` +
    `<trackIDList><trackID>${trackId}</trackID></trackIDList>` +
    `<timeSpanList><timeSpan><startTime>${toISO(startMs)}</startTime><endTime>${toISO(endMs)}</endTime></timeSpan></timeSpanList>` +
    `<maxResults>40</maxResults><searchResultPostion>0</searchResultPostion></CMSearchDescription>`;
  const r = await authedText(dev, "POST", "/ISAPI/ContentMgmt/search", sx);
  if (r.status !== 200) { log.warn(`ContentMgmt search status ${r.status}: ${String(r.text).slice(0, 120)}`); return null; }
  const uris = [...r.text.matchAll(/<playbackURI>([\s\S]*?)<\/playbackURI>/g)].map((m) => m[1].replace(/&amp;/g, "&").trim());
  const segs = uris.map((u) => ({
    uri: u,
    segStartMs: compactToMs((u.match(/starttime=(\d{8}T\d{6}Z)/) || [])[1]),
    segEndMs: compactToMs((u.match(/endtime=(\d{8}T\d{6}Z)/) || [])[1]),
    size: Number((u.match(/size=(\d+)/) || [])[1]) || 0,
  })).filter((s) => s.uri && Number.isFinite(s.segStartMs));
  if (!segs.length) return null;
  return segs.find((s) => startMs >= s.segStartMs - 2000 && startMs <= s.segEndMs + 2000) || segs[0];
}

// Abre el stream de descarga (MPEG-PS). Devuelve { stream, abort }.
// (El header Range lo IGNORAN estos NVR → el archivo baja siempre desde el inicio;
//  el seek fino se hace con input-seek de ffmpeg.)
export function openDownload(dev, playbackURI) {
  const base = devBase(dev);
  const path = "/ISAPI/ContentMgmt/download";
  return new Promise(async (resolve, reject) => {
    const wa = await probe(base, path);
    const auth = authHeader({ user: base.user, pass: base.pass, wa, method: "POST", uri: path });
    const body = `<downloadRequest version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema"><playbackURI>${playbackURI.replace(/&/g, "&amp;")}</playbackURI></downloadRequest>`;
    const req = lib(base.secure).request(
      { host: base.host, port: base.port, path, method: "POST", agent: false, rejectUnauthorized: false,
        headers: { Authorization: auth, "Content-Type": "application/xml", "Content-Length": Buffer.byteLength(body), Connection: "close" } },
      (res) => {
        if (res.statusCode !== 200 && res.statusCode !== 206) { res.resume(); reject(new Error("download_status_" + res.statusCode)); return; }
        resolve({ stream: res, abort: () => { try { req.destroy(); } catch { /* noop */ } } });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

export default { searchSegment, openDownload, compactToMs };
