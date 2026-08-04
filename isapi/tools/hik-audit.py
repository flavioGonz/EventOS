#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""hik-audit — audita canal por canal que analitica soporta y que tiene configurado.

SOLO GET (lectura). No cambia NADA en los equipos. Usa UNA sola autenticacion
digest por NVR (ver la leccion en isapi/tools/... : pedir un reto por request
hace que el DS-9632NI corte a las ~88).

Uso (desde el CT101, saca credenciales de la config de EventOS):

    python3 hik-audit.py --from-eventos --out /tmp/audit.json

    --channels 1-29        acotar canales (por defecto: los descubre solos)
    --host/--port/--user/--password   apuntar a un equipo suelto

Guarda un JSON con el XML crudo (recortado) de cada consulta, para analizarlo
despues sin tener que volver a golpear los equipos.
"""
import argparse, base64, gzip, hashlib, http.client, json, os, re, sys, threading, time

UA = "eventos-isapi-audit/1"

# ---- lo que se le pregunta a CADA canal ------------------------------------
PER_CHANNEL = [
    ("line_cap",       "/ISAPI/Smart/LineDetection/{ch}/capabilities"),
    ("line_rules",     "/ISAPI/Smart/LineDetection/{ch}/lineItem"),
    ("field_cap",      "/ISAPI/Smart/FieldDetection/{ch}/capabilities"),
    ("field_rules",    "/ISAPI/Smart/FieldDetection/{ch}/regions"),
    ("entrance_cap",   "/ISAPI/Smart/regionEntrance/{ch}/capabilities"),
    ("entrance_rules", "/ISAPI/Smart/regionEntrance/{ch}/regions"),
    ("exiting_cap",    "/ISAPI/Smart/regionExiting/{ch}/capabilities"),
    ("exiting_rules",  "/ISAPI/Smart/regionExiting/{ch}/regions"),
    ("intelligent",    "/ISAPI/Intelligent/channels/{ch}/capabilities"),
    ("trig_line",      "/ISAPI/Event/triggers/LineDetection-{ch}/notifications"),
    ("trig_field",     "/ISAPI/Event/triggers/FieldDetection-{ch}/notifications"),
    ("trig_vmd",       "/ISAPI/Event/triggers/VMD-{ch}/notifications"),
]
# ---- una sola vez por equipo ------------------------------------------------
PER_DEVICE = [
    ("device_info",   "/ISAPI/System/deviceInfo"),
    ("input_proxy",   "/ISAPI/ContentMgmt/InputProxy/channels"),
    ("intelli_list",  "/ISAPI/Intelligent/intelliChannelList"),
    ("intelli_cap",   "/ISAPI/Intelligent/capabilities"),
    ("smart_cap",     "/ISAPI/Smart/capabilities"),
    ("event_cap",     "/ISAPI/Event/capabilities"),
    # armado horario: una sola llamada trae la grilla semanal de TODOS los canales
    ("sched_line",     "/ISAPI/Event/schedules/lineDetections"),
    ("sched_field",    "/ISAPI/Event/schedules/fieldDetections"),
    ("sched_entrance", "/ISAPI/Event/schedules/regionEntrances"),
    ("sched_exiting",  "/ISAPI/Event/schedules/regionExitings"),
    ("sched_motion",   "/ISAPI/Event/schedules/motionDetections"),
]
MAXBYTES = 400000
KEEP = 6000          # cuanto XML guardar por respuesta


def _h(x):
    return hashlib.md5(x.encode("utf-8")).hexdigest()


def _parse_challenge(header):
    out = {}
    for m in re.finditer(r'(\w+)\s*=\s*(?:"([^"]*)"|([^,\s]+))', header):
        out[m.group(1).lower()] = m.group(2) if m.group(2) is not None else m.group(3)
    return out


class DigestSession(object):
    """Un reto digest cacheado + keep-alive. NO pedir un reto por request."""

    def __init__(self, host, port, user, password, timeout=10.0):
        self.host, self.port = host, int(port)
        self.user, self.password = user, password
        self.timeout, self.ch, self.nc = timeout, None, 0
        self.lock, self.conn, self.challenges = threading.Lock(), None, 0

    def _connect(self):
        if self.conn is None:
            self.conn = http.client.HTTPConnection(self.host, self.port, timeout=self.timeout)
        return self.conn

    def close(self):
        try:
            if self.conn:
                self.conn.close()
        except Exception:
            pass
        self.conn = None

    def _auth(self, method, uri):
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
        resp = _h("%s:%s:%s:%s:%s:%s" % (ha1, nonce, nc, cnonce, qop, ha2)) if qop \
            else _h("%s:%s:%s" % (ha1, nonce, ha2))
        parts = ['username="%s"' % self.user, 'realm="%s"' % realm, 'nonce="%s"' % nonce,
                 'uri="%s"' % uri, 'response="%s"' % resp]
        if ch.get("opaque"):
            parts.append('opaque="%s"' % ch["opaque"])
        if ch.get("algorithm"):
            parts.append("algorithm=%s" % ch["algorithm"])
        if qop:
            parts += ["qop=%s" % qop, "nc=%s" % nc, 'cnonce="%s"' % cnonce]
        return "Digest " + ", ".join(parts)

    def _raw(self, uri, headers):
        for attempt in (0, 1):
            try:
                conn = self._connect()
                conn.request("GET", uri, headers=headers)
                r = conn.getresponse()
                body = r.read(MAXBYTES)
                r.read()
                return r.status, dict(r.getheaders()), body
            except (http.client.HTTPException, OSError):
                self.close()
                if attempt:
                    raise
        return 0, {}, b""

    def challenge(self, uri="/ISAPI/System/deviceInfo"):
        st, hdrs, _ = self._raw(uri, {"Accept": "*/*", "User-Agent": UA})
        wa = hdrs.get("WWW-Authenticate") or hdrs.get("www-authenticate")
        if st == 401 and wa and wa.lower().startswith("digest"):
            self.ch = _parse_challenge(wa[6:])
            self.nc = 0
            self.challenges += 1
            return True
        if st != 401:
            self.ch = self.ch or {}
            return True
        return False

    def get(self, uri):
        if self.ch is None and not self.challenge(uri):
            return 401, "", b""
        hdrs = {"Accept": "*/*", "User-Agent": UA}
        if self.ch:
            hdrs["Authorization"] = self._auth("GET", uri)
        st, rh, body = self._raw(uri, hdrs)
        if st == 401:
            wa = rh.get("WWW-Authenticate") or rh.get("www-authenticate") or ""
            if wa.lower().startswith("digest"):
                self.ch = _parse_challenge(wa[6:])
                self.nc = 0
                self.challenges += 1
                hdrs["Authorization"] = self._auth("GET", uri)
                st, rh, body = self._raw(uri, hdrs)
        return st, (rh.get("Content-Type") or rh.get("content-type") or ""), body


# ---------------------------------------------------------------------------
EVENTOS_CONFIGS = ["/opt/eventos/server/data/eventos.config.json",
                   "/opt/eventos/data/eventos.config.json", "./eventos.config.json"]
RTSP_CRED_RE = re.compile(r"rtsp://([^:/@\s]+):([^@/\s]+)@([^:/\s]+)(?::(\d+))?", re.I)


def _walk(n):
    if isinstance(n, dict):
        yield n
        for v in n.values():
            for x in _walk(v):
                yield x
    elif isinstance(n, list):
        for v in n:
            for x in _walk(v):
                yield x


def _first(d, keys):
    for k in keys:
        for kk in d:
            if kk.lower() == k.lower() and d[kk] not in (None, ""):
                return d[kk]
    return None


def devices_from_eventos(path=None):
    cfg = used = None
    for p in ([path] if path else EVENTOS_CONFIGS):
        if p and os.path.exists(p):
            cfg, used = json.load(open(p, encoding="utf-8")), p
            break
    if cfg is None:
        raise SystemExit("no encontre eventos.config.json; pasala con --from-eventos /ruta")
    creds = {}
    for u, pw, h, _ in RTSP_CRED_RE.findall(json.dumps(cfg)):
        creds.setdefault(h, (u, pw))
    found, seen = [], set()
    for d in _walk(cfg):
        if not isinstance(d, dict):
            continue
        host = _first(d, ("ip", "host", "hostname", "address"))
        if not host or not isinstance(host, str):
            continue
        port = None
        tags = d.get("tags") or []
        if isinstance(tags, str):
            tags = [tags]
        for t in tags:
            m = re.fullmatch(r"isapi:(\d+)", str(t).strip(), re.I)
            if m:
                port = int(m.group(1))
        if port is None:
            continue                      # sólo equipos con tag isapi:<puerto>
        user = _first(d, ("user", "username")) or (creds.get(host) or (None, None))[0]
        pw = _first(d, ("pass", "password")) or (creds.get(host) or (None, None))[1]
        if not (user and pw) or (host, port) in seen:
            continue
        seen.add((host, port))
        found.append({"label": str(_first(d, ("label", "name", "id")) or "%s:%s" % (host, port)),
                      "host": host, "port": port, "user": str(user), "password": str(pw)})
    return found, used


CH_RE = re.compile(r"<id>\s*(\d+)\s*</id>")


def discover_channels(sess):
    st, _, body = sess.get("/ISAPI/ContentMgmt/InputProxy/channels")
    if st != 200:
        return []
    txt = body.decode("utf-8", "replace")
    blocks = re.findall(r"<InputProxyChannel>(.*?)</InputProxyChannel>", txt, re.S)
    out = []
    for b in blocks:
        m = CH_RE.search(b)
        if m:
            out.append(int(m.group(1)))
    return sorted(set(out))


def parse_range(spec):
    out = []
    for part in spec.split(","):
        part = part.strip()
        if "-" in part:
            a, b = part.split("-", 1)
            out += list(range(int(a), int(b) + 1))
        elif part:
            out.append(int(part))
    return sorted(set(out))


def audit(dev, channels, verbose=True):
    sess = DigestSession(dev["host"], dev["port"], dev["user"], dev["password"])
    if not sess.challenge():
        sys.stderr.write("  !! %s no ofrece Digest en %s\n" % (dev["label"], dev["port"]))
        return None
    res = {"device": {k: dev[k] for k in ("label", "host", "port", "user")},
           "when": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "device_level": {}, "channels": {}}
    for key, uri in PER_DEVICE:
        st, ct, body = sess.get(uri)
        res["device_level"][key] = {"uri": uri, "http": st,
                                    "xml": body[:MAXBYTES].decode("utf-8", "replace")}
    chans = channels or discover_channels(sess)
    if not chans:
        chans = list(range(1, 33))
    res["channels_probed"] = chans
    if verbose:
        sys.stderr.write("  %s: %d canales -> %d consultas\n"
                         % (dev["label"], len(chans), len(chans) * len(PER_CHANNEL)))
    for i, ch in enumerate(chans, 1):
        entry = {}
        for key, tpl in PER_CHANNEL:
            uri = tpl.format(ch=ch)
            st, ct, body = sess.get(uri)
            entry[key] = {"uri": uri, "http": st,
                          "xml": body[:KEEP].decode("utf-8", "replace")}
        res["channels"][str(ch)] = entry
        if verbose and i % 5 == 0:
            sys.stderr.write("    canal %d/%d (retos digest: %d)\n" % (i, len(chans), sess.challenges))
    res["digest_challenges"] = sess.challenges
    sess.close()
    return res


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--from-eventos", nargs="?", const="", default=None, metavar="CONFIG")
    ap.add_argument("--host", default="")
    ap.add_argument("--port", type=int, default=80)
    ap.add_argument("--user", default="admin")
    ap.add_argument("--password", default=os.environ.get("HIK_PASSWORD", ""))
    ap.add_argument("--label", default="")
    ap.add_argument("--channels", default="", help="ej. 1-29 o 1,2,6")
    ap.add_argument("--out", default="audit.json")
    a = ap.parse_args()

    chans = parse_range(a.channels) if a.channels else None
    if a.from_eventos is not None:
        devs, cfg = devices_from_eventos(a.from_eventos or None)
        sys.stderr.write("config: %s\n%d equipo(s):\n" % (cfg, len(devs)))
        for d in devs:
            sys.stderr.write("  %-28s %s:%s user=%s pass=%s\n"
                             % (d["label"][:28], d["host"], d["port"], d["user"],
                                "*" * len(d["password"])))
    else:
        if not a.host or not a.password:
            sys.exit("faltan --host y --password (o usá --from-eventos)")
        devs = [{"label": a.label or a.host, "host": a.host, "port": a.port,
                 "user": a.user, "password": a.password}]

    out = {"audits": []}
    t0 = time.time()
    for d in devs:
        sys.stderr.write("\n=== %s (%s:%s) ===\n" % (d["label"], d["host"], d["port"]))
        r = audit(d, chans)
        if r:
            out["audits"].append(r)
    out["elapsed_s"] = round(time.time() - t0, 1)
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False)
    sys.stderr.write("\n-> %s  (%.1f s, %d equipos)\n"
                     % (a.out, out["elapsed_s"], len(out["audits"])))


if __name__ == "__main__":
    main()
