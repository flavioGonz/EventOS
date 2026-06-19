// util/digestFetch.js — GET HTTP con Digest auth (sin dependencias), soporta
// respuesta binaria (JPEG de snapshot ISAPI). Reusa la mecánica de
// discovery/hikvision.js pero devolviendo Buffer.
import crypto from "node:crypto";

const md5 = (s) => crypto.createHash("md5").update(s).digest("hex");

function parseAuthHeader(header) {
  const out = {};
  const re = /(\w+)=(?:"([^"]*)"|([^,\s]+))/g;
  let m;
  while ((m = re.exec(header))) out[m[1].toLowerCase()] = m[2] !== undefined ? m[2] : m[3];
  return out;
}

// Construye el header Authorization Digest. `ch` es el reto cacheado (realm,
// nonce, qop, opaque) + un contador `nc` que se incrementa en cada uso (el RFC
// permite REUSAR el nonce mientras no expire, evitando el round-trip del 401).
function buildAuth({ user, pass, method, uri, ch }) {
  const nc = (ch.nc++).toString(16).padStart(8, "0");
  const cnonce = crypto.randomBytes(8).toString("hex");
  const ha1 = md5(`${user}:${ch.realm}:${pass}`);
  const ha2 = md5(`${method}:${uri}`);
  const useQop = ch.qop ? (ch.qop.split(",")[0] || "auth").trim() : null;
  const response = useQop
    ? md5(`${ha1}:${ch.nonce}:${nc}:${cnonce}:${useQop}:${ha2}`)
    : md5(`${ha1}:${ch.nonce}:${ha2}`);
  let h = `Digest username="${user}", realm="${ch.realm}", nonce="${ch.nonce}", uri="${uri}", response="${response}"`;
  if (useQop) h += `, qop=${useQop}, nc=${nc}, cnonce="${cnonce}"`;
  if (ch.opaque) h += `, opaque="${ch.opaque}"`;
  return h;
}

// Caché del reto digest por host (evita el 401 en cada snapshot → ~2x fps MJPEG).
const challengeCache = new Map(); // `${host}:${port}:${user}` → { realm, nonce, qop, opaque, nc }

// GET con Digest (fallback Basic). Devuelve { status, buffer, contentType }.
// `path` debe ser la ruta usada en la URI del digest (sin host).
export async function digestGetBuffer({ host, port, https = false, path: p, user, pass, timeoutMs = 6000 }) {
  const url = `${https ? "https" : "http"}://${host}:${port}${p}`;
  const key = `${host}:${port}:${user}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const done = (res, ab) => ({ status: res.status, buffer: Buffer.from(ab), contentType: res.headers.get("content-type") || "" });
  try {
    // 1) Camino rápido: si tenemos el reto cacheado, autentica directo (1 viaje).
    const cached = challengeCache.get(key);
    if (cached && cached.nonce) {
      const headers = { Authorization: buildAuth({ user, pass, method: "GET", uri: p, ch: cached }) };
      const res = await fetch(url, { signal: ctrl.signal, headers, redirect: "manual" });
      if (res.status !== 401) return done(res, await res.arrayBuffer());
      challengeCache.delete(key); // nonce expirado → rehacer handshake
    }
    // 2) Handshake: reto 401 → cachea nonce → reintenta autenticado.
    let res = await fetch(url, { signal: ctrl.signal, redirect: "manual" });
    if (res.status === 401) {
      const wa = res.headers.get("www-authenticate") || "";
      let headers = {};
      if (/digest/i.test(wa)) {
        const a = parseAuthHeader(wa);
        const ch = { realm: a.realm || "", nonce: a.nonce || "", qop: a.qop, opaque: a.opaque, nc: 1 };
        challengeCache.set(key, ch);
        headers.Authorization = buildAuth({ user, pass, method: "GET", uri: p, ch });
      } else {
        headers.Authorization = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
      }
      res = await fetch(url, { signal: ctrl.signal, headers, redirect: "manual" });
    }
    return done(res, await res.arrayBuffer());
  } finally {
    clearTimeout(t);
  }
}


// Request con Digest (método/cuerpo arbitrarios). Para disparar salidas/relés
// (PUT ISAPI). Devuelve { status, text }. Tolerante.
export async function digestRequest({ host, port, https = false, path: p, method = "PUT", body = "", contentType = "application/xml", user, pass, timeoutMs = 6000 }) {
  const url = `${https ? "https" : "http"}://${host}:${port}${p}`;
  const key = `${host}:${port}:${user}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const send = (auth) => fetch(url, { method, signal: ctrl.signal, redirect: "manual",
    headers: { ...(auth ? { Authorization: auth } : {}), "Content-Type": contentType }, body: body || undefined });
  try {
    const cached = challengeCache.get(key);
    let res = cached && cached.nonce
      ? await send(buildAuth({ user, pass, method, uri: p, ch: cached }))
      : await send(null);
    if (res.status === 401) {
      const wa = res.headers.get("www-authenticate") || "";
      if (/digest/i.test(wa)) {
        const ch = parseAuthHeader(wa); ch.nc = 1; challengeCache.set(key, ch);
        res = await send(buildAuth({ user, pass, method, uri: p, ch }));
      } else {
        res = await send("Basic " + Buffer.from(`${user}:${pass}`).toString("base64"));
      }
    }
    const text = await res.text().catch(() => "");
    return { status: res.status, text };
  } catch (e) {
    return { status: 0, text: String((e && e.message) || e) };
  } finally { clearTimeout(t); }
}

export default { digestGetBuffer, digestRequest };
