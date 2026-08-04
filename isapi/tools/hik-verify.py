#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""hik-verify — sonda el catalogo ISAPI de EventOS contra un equipo Hikvision REAL.

AUTOCONTENIDO: no necesita el repo, ni pip, ni internet. Solo Python 3.
SOLO HACE GET (lectura). Nunca PUT/POST/DELETE: no cambia NADA en el equipo.
Salta los endpoints que cuelgan o disparan trabajo (alertStream, download,
reboot, updateFirmware, backup, capture...).

Uso:
    python3 hik-verify.py --host 192.168.7.91 --port 82 --user admin \
        --password 'LA-CLAVE' --label srv2 --channels 1,2,6 --out verify-srv2.json

    --dry-run          muestra que probaria, sin tocar el equipo
    --only capabilities  sonda solo los paths que contengan ese texto
    --max 50           limita la cantidad de sondas (para una prueba corta)

Despues pasale el JSON a Claude / corre ingest_verify.py en isapi/tools/.
"""
import argparse, base64, gzip, json, os, re, sys, time, urllib.error, urllib.request
from concurrent.futures import ThreadPoolExecutor

# --- catalogo embebido: 511 endpoints GET del catalogo ISAPI de EventOS -------
CATALOG_B64 = (
    "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"
)


# --------------------------------------------------------------------------- #
# Credenciales desde la config de EventOS (asi nadie tiene que tipear la clave)
# --------------------------------------------------------------------------- #
EVENTOS_CONFIGS = [
    "/opt/eventos/server/data/eventos.config.json",
    "/opt/eventos/data/eventos.config.json",
    "./eventos.config.json",
]
RTSP_CRED_RE = re.compile(r"rtsp://([^:/@\s]+):([^@/\s]+)@([^:/\s]+)(?::(\d+))?", re.I)
USER_KEYS = ("user", "username", "usuario", "login", "isapiUser")
PASS_KEYS = ("pass", "password", "passwd", "clave", "isapiPass")
HOST_KEYS = ("ip", "host", "hostname", "address", "addr")
PORT_KEYS = ("isapiPort", "httpPort", "port", "puerto")


def _walk(node):
    if isinstance(node, dict):
        yield node
        for v in node.values():
            for x in _walk(v):
                yield x
    elif isinstance(node, list):
        for v in node:
            for x in _walk(v):
                yield x


def _first(d, keys):
    for k in keys:
        for kk in d:
            if kk.lower() == k.lower() and d[kk] not in (None, ""):
                return d[kk]
    return None


def _tag_port(d):
    tags = d.get("tags") or d.get("Tags") or []
    if isinstance(tags, str):
        tags = [tags]
    for t in tags:
        m = re.fullmatch(r"isapi:(\d+)", str(t).strip(), re.I)
        if m:
            return int(m.group(1))
    return None


def devices_from_eventos(path=None, want_ports=(82, 83, 80)):
    """Saca (label, host, port, user, password) de la config de EventOS.

    Busca campos user/pass explicitos y, si no estan, los recupera de cualquier
    URL rtsp://usuario:clave@host que haya para ese mismo host.
    """
    paths = [path] if path else EVENTOS_CONFIGS
    cfg = None
    used = None
    for pth in paths:
        if pth and os.path.exists(pth):
            with open(pth, encoding="utf-8") as f:
                cfg = json.load(f)
            used = pth
            break
    if cfg is None:
        raise SystemExit("no encontre la config de EventOS. Pasala con --from-eventos /ruta/eventos.config.json")

    # 1) credenciales que aparezcan en cualquier rtsp:// del archivo, por host
    creds_by_host = {}
    blob = json.dumps(cfg)
    for u, pw, h, _pt in RTSP_CRED_RE.findall(blob):
        creds_by_host.setdefault(h, (u, pw))

    found, seen = [], set()
    for d in _walk(cfg):
        if not isinstance(d, dict):
            continue
        host = _first(d, HOST_KEYS)
        if not host or not isinstance(host, str):
            continue
        typ = str(_first(d, ("type", "tipo", "kind")) or "").lower()
        # un puerto declarado como ISAPI (tag `isapi:NN` o campo isapiPort/httpPort)
        # se acepta tal cual; un `port` generico solo si es de los habituales.
        explicit = _tag_port(d) or _first(d, ("isapiPort", "httpPort"))
        port = explicit if explicit else _first(d, PORT_KEYS)
        try:
            port = int(port) if port else None
        except (TypeError, ValueError):
            port = None
        if port is None:
            continue
        if not explicit and port not in want_ports:
            continue
        if typ and typ not in ("nvr", "dvr", "hikvision", "camera", "ipc"):
            continue
        user = _first(d, USER_KEYS)
        pw = _first(d, PASS_KEYS)
        if not (user and pw):
            cb = creds_by_host.get(host)
            if cb:
                user, pw = user or cb[0], pw or cb[1]
        if not (user and pw):
            continue
        label = str(_first(d, ("label", "name", "nombre", "id")) or "%s:%s" % (host, port))
        key = (host, port)
        if key in seen:
            continue
        seen.add(key)
        found.append({"label": label, "host": host, "port": port,
                      "user": str(user), "password": str(pw), "type": typ})
    return found, used



# --------------------------------------------------------------------------- #
# Cliente Digest con sesion reutilizada.
#
# LECCION APRENDIDA (03-ago-2026): urllib.HTTPDigestAuthHandler pide un reto 401
# NUEVO en CADA request. Contra un DS-9632NI eso agota el limite de sesiones del
# equipo: las primeras ~88 sondas responden y a partir de ahi TODO da 401.
# La forma correcta (la que ya usa EventOS en digestFetch.js) es pedir el reto
# UNA vez y reusarlo firmando cada request con `nc` incremental.
# --------------------------------------------------------------------------- #
import hashlib, http.client, threading


def _h(x):
    return hashlib.md5(x.encode("utf-8")).hexdigest()


def _parse_challenge(header):
    """`Digest realm="x", nonce="y", qop="auth"` -> dict"""
    out = {}
    for m in re.finditer(r'(\w+)\s*=\s*(?:"([^"]*)"|([^,\s]+))', header):
        out[m.group(1).lower()] = m.group(2) if m.group(2) is not None else m.group(3)
    return out


class DigestSession(object):
    """Una conexion HTTP con keep-alive y un reto digest cacheado."""

    def __init__(self, host, port, user, password, timeout=8.0):
        self.host, self.port = host, int(port)
        self.user, self.password = user, password
        self.timeout = timeout
        self.ch = None
        self.nc = 0
        self.lock = threading.Lock()
        self.conn = None
        self.challenges = 0

    def _connect(self):
        if self.conn is None:
            self.conn = http.client.HTTPConnection(self.host, self.port, timeout=self.timeout)
        return self.conn

    def _close(self):
        try:
            if self.conn:
                self.conn.close()
        except Exception:
            pass
        self.conn = None

    def _auth_header(self, method, uri):
        with self.lock:
            self.nc += 1
            nc = "%08x" % self.nc
            ch = dict(self.ch)
        cnonce = _h("%s%s%s" % (nc, self.host, self.user))[:16]
        realm, nonce = ch.get("realm", ""), ch.get("nonce", "")
        qop = ch.get("qop")
        if qop and "," in qop:
            qop = "auth" if "auth" in [q.strip() for q in qop.split(",")] else qop.split(",")[0].strip()
        ha1 = _h("%s:%s:%s" % (self.user, realm, self.password))
        if (ch.get("algorithm") or "").upper() == "MD5-SESS":
            ha1 = _h("%s:%s:%s" % (ha1, nonce, cnonce))
        ha2 = _h("%s:%s" % (method, uri))
        if qop:
            resp = _h("%s:%s:%s:%s:%s:%s" % (ha1, nonce, nc, cnonce, qop, ha2))
        else:
            resp = _h("%s:%s:%s" % (ha1, nonce, ha2))
        parts = ['username="%s"' % self.user, 'realm="%s"' % realm,
                 'nonce="%s"' % nonce, 'uri="%s"' % uri, 'response="%s"' % resp]
        if ch.get("opaque"):
            parts.append('opaque="%s"' % ch["opaque"])
        if ch.get("algorithm"):
            parts.append("algorithm=%s" % ch["algorithm"])
        if qop:
            parts += ["qop=%s" % qop, "nc=%s" % nc, 'cnonce="%s"' % cnonce]
        return "Digest " + ", ".join(parts)

    def _raw(self, uri, headers):
        conn = self._connect()
        try:
            conn.request("GET", uri, headers=headers)
            r = conn.getresponse()
            body = r.read(self.maxbytes) if hasattr(self, "maxbytes") else r.read()
            r.read()  # drenar para poder reusar la conexion
            return r.status, dict(r.getheaders()), body
        except (http.client.HTTPException, OSError):
            self._close()
            conn = self._connect()
            conn.request("GET", uri, headers=headers)
            r = conn.getresponse()
            body = r.read()
            return r.status, dict(r.getheaders()), body

    def challenge(self, uri="/ISAPI/System/deviceInfo"):
        """Pide UN reto 401 y lo cachea."""
        st, hdrs, _ = self._raw(uri, {"Accept": "*/*", "User-Agent": UA})
        wa = hdrs.get("WWW-Authenticate") or hdrs.get("www-authenticate")
        if st == 401 and wa and wa.lower().startswith("digest"):
            self.ch = _parse_challenge(wa[6:])
            self.nc = 0
            self.challenges += 1
            return True
        if st != 401:
            self.ch = self.ch or {}
            return True   # el equipo no pide auth
        return False

    def get(self, uri, maxbytes=200000):
        """GET autenticado. Devuelve (status, content_type, body)."""
        self.maxbytes = maxbytes
        if self.ch is None and not self.challenge(uri):
            return 401, "", b""
        hdrs = {"Accept": "*/*", "User-Agent": UA}
        if self.ch:
            hdrs["Authorization"] = self._auth_header("GET", uri)
        st, rh, body = self._raw(uri, hdrs)
        if st == 401:
            # el nonce caduco (o `stale`): pedimos UN reto nuevo y reintentamos
            wa = rh.get("WWW-Authenticate") or rh.get("www-authenticate") or ""
            if wa.lower().startswith("digest"):
                self.ch = _parse_challenge(wa[6:])
                self.nc = 0
                self.challenges += 1
                hdrs["Authorization"] = self._auth_header("GET", uri)
                st, rh, body = self._raw(uri, hdrs)
        ct = rh.get("Content-Type") or rh.get("content-type") or ""
        return st, ct, body


UA = "eventos-isapi-verify/2"


DENY = ("alertStream", "/download", "/export", "networkCapture", "capture",
        "/upgrade", "updateFirmware", "reboot", "restore", "factoryReset",
        "/backup", "channels/picture", "liveView")

DEFAULT_PARAMS = {
    "channelID": "1", "ID": "1", "id": "1", "portID": "1", "trackID": "101",
    "streamID": "101", "trackStreamID": "101", "inputID": "1", "outputID": "1",
    "audioChannelID": "1", "videoChannelID": "1", "radarChannelID": "1",
    "indexID": "1", "no": "1", "index": "1", "num": "1",
    "patrolID": "1", "textID": "1", "presetID": "1", "patternID": "1",
    "AppID": "1", "cardNo": "1", "employeeNo": "1", "FDID": "1", "FPID": "1",
    "planID": "1", "taskID": "1", "ruleID": "1", "regionID": "1", "lineID": "1",
}
PARAM_RE = re.compile(r"\{([^}]+)\}")
STATUS_RE = re.compile(rb"<statusCode>\s*(\d+)\s*</statusCode>")
SUB_RE = re.compile(rb"<subStatusCode>\s*([\w.]+)\s*</subStatusCode>")
ROOT_RE = re.compile(rb"<\s*([A-Za-z_][\w.\-]*)[\s>]")


def load_catalog():
    return json.loads(gzip.decompress(base64.b64decode(CATALOG_B64)).decode())


def opener(base, user, password):
    mgr = urllib.request.HTTPPasswordMgrWithDefaultRealm()
    mgr.add_password(None, base, user, password)
    return urllib.request.build_opener(
        urllib.request.HTTPDigestAuthHandler(mgr),
        urllib.request.HTTPBasicAuthHandler(mgr))


def fill(path, params):
    missing = []

    def sub(m):
        n = m.group(1)
        v = params.get(n) or params.get(re.sub(r"\d+$", "", n))
        if v is None:
            missing.append(n)
            return m.group(0)
        return v

    return PARAM_RE.sub(sub, path), missing


def classify(status, body):
    if status == 401:
        return "auth_failed", None
    if status == 404:
        return "absent", None
    sub = SUB_RE.search(body or b"")
    sc = STATUS_RE.search(body or b"")
    subs = sub.group(1).decode() if sub else None
    code = int(sc.group(1)) if sc else None
    if subs in ("notSupport", "notSupported", "invalidOperation"):
        return "not_supported", subs
    if status == 200:
        return ("supported", subs) if code in (None, 1) else ("error_response", subs)
    if status in (400, 403, 500):
        return ("not_supported" if subs else "error_response"), subs
    return "error_response", subs


def probe(op, sess, params, maxbytes):
    path, missing = fill(op["p"], params)
    if missing:
        return {"path": op["p"], "result": "skipped_params", "missing": missing,
                "category": op["c"]}
    t0 = time.time()
    try:
        status, ctype, body = sess.get(path, maxbytes)
    except Exception as e:
        return {"path": op["p"], "url_path": path, "result": "error",
                "detail": type(e).__name__ + ": " + str(e)[:120],
                "category": op["c"], "ms": int((time.time() - t0) * 1000)}
    res, subs = classify(status, body)
    root = ROOT_RE.search(body.lstrip()[:400] or b"")
    out = {"method": "GET", "path": op["p"], "url_path": path, "tier": op["t"],
           "category": op["c"], "summary": op["s"], "result": res, "http": status,
           "ms": int((time.time() - t0) * 1000),
           "content_type": (ctype or "").split(";")[0], "bytes": len(body)}
    if subs:
        out["subStatusCode"] = subs
    if root and not (ctype or "").startswith("image"):
        rn = root.group(1).decode()
        if rn != "?xml":
            out["root"] = rn
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--host", default="")
    ap.add_argument("--port", type=int, default=80)
    ap.add_argument("--user", default="admin")
    ap.add_argument("--password", default=os.environ.get("HIK_PASSWORD", ""))
    ap.add_argument("--label", default="")
    ap.add_argument("--channels", default="1")
    ap.add_argument("--param", action="append", default=[], metavar="k=v")
    ap.add_argument("--only", default="")
    ap.add_argument("--tier", default="reference", choices=["reference", "narrative", "all"])
    ap.add_argument("--max", type=int, default=0)
    ap.add_argument("--concurrency", type=int, default=1,
                    help="(en desuso) el barrido es secuencial sobre una sola sesion digest")
    ap.add_argument("--pause", type=float, default=0.0,
                    help="segundos de espera entre sondas (subilo si el equipo se queja)")
    ap.add_argument("--abort-after", type=int, default=15,
                    help="cortar tras N respuestas 401 seguidas")
    ap.add_argument("--timeout", type=float, default=8.0)
    ap.add_argument("--maxbytes", type=int, default=200000)
    ap.add_argument("--out", default="verify-report.json")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--from-eventos", nargs="?", const="", default=None, metavar="CONFIG",
                    help="saca host/puerto/usuario/clave de la config de EventOS "
                         "(por defecto /opt/eventos/server/data/eventos.config.json)")
    ap.add_argument("--list-devices", action="store_true",
                    help="con --from-eventos: lista los equipos detectados (clave enmascarada) y sale")
    ap.add_argument("--outdir", default=".", help="con --from-eventos: donde deja los JSON")
    ap.add_argument("--emit-b64", action="store_true",
                    help="ademas del JSON, imprime el reporte comprimido en base64 "
                         "para copiar y pegar (no lleva credenciales)")
    a = ap.parse_args()

    if a.from_eventos is not None:
        devs, cfgpath = devices_from_eventos(a.from_eventos or None)
        sys.stderr.write("config: %s\n%d equipo(s) con credenciales:\n" % (cfgpath, len(devs)))
        for d in devs:
            sys.stderr.write("  %-28s %s:%s  user=%s  pass=%s\n"
                             % (d["label"][:28], d["host"], d["port"], d["user"],
                                "*" * len(d["password"])))
        if a.list_devices or not devs:
            return
        for d in devs:
            tag = re.sub(r"\W+", "-", d["label"]).strip("-").lower() or ("%s-%s" % (d["host"], d["port"]))
            out = os.path.join(a.outdir, "verify-%s.json" % tag)
            sys.stderr.write("\n=== %s (%s:%s) ===\n" % (d["label"], d["host"], d["port"]))
            run_sweep(a, d["host"], d["port"], d["user"], d["password"], d["label"], out)
        return

    if not a.password and not a.dry_run:
        sys.exit("falta --password (o la variable HIK_PASSWORD)")

    run_sweep(a, a.host, a.port, a.user, a.password, a.label, a.out)


def run_sweep(a, host, port, user, password, label, outfile):
    ops = load_catalog()
    if a.tier != "all":
        ops = [o for o in ops if o["t"] == a.tier]
    ops = [o for o in ops if not any(d.lower() in o["p"].lower() for d in DENY)]
    if a.only:
        ops = [o for o in ops if a.only.lower() in o["p"].lower()]

    params = dict(DEFAULT_PARAMS)
    for kv in a.param:
        k, _, v = kv.partition("=")
        params[k.strip()] = v.strip()

    channels = [c.strip() for c in a.channels.split(",") if c.strip()] or ["1"]
    plan = []
    for o in ops:
        if "{channelID}" in o["p"] and len(channels) > 1:
            for ch in channels:
                plan.append((o, dict(params, channelID=ch)))
        else:
            plan.append((o, dict(params, channelID=channels[0])))
    if a.max:
        plan = plan[:a.max]

    base = "http://%s:%d" % (host, int(port))
    sys.stderr.write("%d sondas GET contra %s (tier=%s, canales=%s)\n"
                     % (len(plan), base, a.tier, ",".join(channels)))
    if a.dry_run:
        for o, p in plan[:60]:
            sys.stderr.write("  GET " + fill(o["p"], p)[0] + "\n")
        if len(plan) > 60:
            sys.stderr.write("  ... y %d mas\n" % (len(plan) - 60))
        return

    sess = DigestSession(host, port, user, password, a.timeout)
    if not sess.challenge():
        sys.stderr.write("  !! el equipo no ofrece Digest en ese puerto\n")
    results, done, consecutive_401 = [], 0, 0
    t0 = time.time()
    for o, p in plan:
        r = probe(o, sess, p, a.maxbytes)
        results.append(r)
        done += 1
        if r["result"] == "auth_failed":
            consecutive_401 += 1
            if consecutive_401 >= a.abort_after:
                sys.stderr.write(
                    "\n  !! %d respuestas 401 seguidas -> el equipo nos esta rechazando.\n"
                    "     Corto aca para no seguir golpeandolo. Sondas utiles: %d\n"
                    % (consecutive_401, done - consecutive_401))
                break
        else:
            consecutive_401 = 0
        if a.pause:
            time.sleep(a.pause)
        if done % 50 == 0:
            sys.stderr.write("  %d/%d  (retos digest pedidos: %d)\n"
                             % (done, len(plan), sess.challenges))
    sess._close()

    summary = {}
    for r in results:
        summary[r["result"]] = summary.get(r["result"], 0) + 1
    report = {"device": {"label": label or "%s:%s" % (host, port),
                         "host": host, "port": int(port), "user": user},
              "when": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
              "channels": channels, "tier": a.tier, "summary": summary,
              "elapsed_s": round(time.time() - t0, 1),
              "digest_challenges": sess.challenges, "results": results}
    with open(outfile, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=1)
    sys.stderr.write(json.dumps(summary, indent=1) + "\n-> %s\n" % outfile)

    if getattr(a, "emit_b64", False):
        slim = {"device": {"label": report["device"]["label"],
                           "host": report["device"]["host"],
                           "port": report["device"]["port"],
                           "user": report["device"]["user"]},
                "when": report["when"], "channels": report["channels"],
                "tier": report["tier"], "summary": summary,
                "results": [{k: r[k] for k in
                             ("path", "url_path", "result", "http", "subStatusCode",
                              "root", "ms", "bytes", "content_type") if k in r}
                            for r in results]}
        blob = base64.b64encode(gzip.compress(
            json.dumps(slim, ensure_ascii=False, separators=(",", ":")).encode())).decode()
        sys.stdout.write("\n----- HIKVERIFY-B64 %s -----\n" % report["device"]["label"])
        for i in range(0, len(blob), 100):
            sys.stdout.write(blob[i:i + 100] + "\n")
        sys.stdout.write("----- FIN (%d chars) -----\n" % len(blob))
        sys.stdout.flush()


if __name__ == "__main__":
    main()
