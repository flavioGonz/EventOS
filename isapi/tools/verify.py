#!/usr/bin/env python3
"""verify.py — probar el catálogo ISAPI contra un equipo REAL y marcar qué soporta.

Sólo hace peticiones **GET** (lectura). Nunca PUT/POST/DELETE: no cambia nada en
el equipo. Aun así, apuntalo a un equipo tuyo y en un momento tranquilo.

Uso típico (correr desde un host con ruta al NVR, p.ej. el CT de EventOS):

    python3 verify.py --host 192.168.7.91 --port 82 --user admin --password '***' \
        --label "srv2-DS9632NI" --channels 1,2,6 --out verify-srv2.json

    python3 verify.py --host ... --dry-run          # muestra qué probaría
    python3 verify.py --host ... --only Smart       # filtra por texto en el path

Después, en la máquina donde vive el catálogo:

    python3 ingest_verify.py verify-srv2.json       # marca el catálogo

Sólo necesita Python 3 estándar (urllib, sqlite3). Sin pip.
"""
import argparse, json, os, re, sqlite3, sys, time, urllib.error, urllib.request
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
DB = os.path.join(HERE, "..", "openapi", "catalog.sqlite")

# GETs que NO conviene probar: se quedan colgados, devuelven binario pesado,
# o arrancan un trabajo en el equipo.
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
        if code in (None, 1):
            return "supported", subs
        return "error_response", subs
    if status in (400, 403, 500):
        return "not_supported" if subs else "error_response", subs
    return "error_response", subs


def probe(op, base, op_open, params, timeout, maxbytes):
    path, missing = fill(op["path"], params)
    if missing:
        return {**op, "result": "skipped_params", "missing": missing}
    url = base + path
    t0 = time.time()
    try:
        req = urllib.request.Request(url, method="GET",
                                     headers={"Accept": "*/*", "User-Agent": "eventos-isapi-verify/1"})
        with op_open.open(req, timeout=timeout) as r:
            body = r.read(maxbytes)
            status, ctype = r.status, r.headers.get("Content-Type", "")
    except urllib.error.HTTPError as e:
        body = e.read(maxbytes) if hasattr(e, "read") else b""
        status, ctype = e.code, e.headers.get("Content-Type", "") if e.headers else ""
    except Exception as e:
        return {**op, "result": "error", "detail": type(e).__name__ + ": " + str(e)[:120],
                "ms": int((time.time() - t0) * 1000)}
    res, subs = classify(status, body)
    root = ROOT_RE.search(body.lstrip()[:400] or b"")
    out = {**op, "url_path": path, "result": res, "http": status,
           "ms": int((time.time() - t0) * 1000), "content_type": ctype.split(";")[0],
           "bytes": len(body)}
    if subs:
        out["subStatusCode"] = subs
    if root and not ctype.startswith("image"):
        rn = root.group(1).decode()
        if rn not in ("?xml",):
            out["root"] = rn
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--host", required=True)
    ap.add_argument("--port", type=int, default=80)
    ap.add_argument("--user", default="admin")
    ap.add_argument("--password", default=os.environ.get("HIK_PASSWORD", ""))
    ap.add_argument("--label", default="", help="nombre del equipo para el reporte")
    ap.add_argument("--channels", default="1", help="canales a probar, ej. 1,2,6")
    ap.add_argument("--param", action="append", default=[], metavar="k=v")
    ap.add_argument("--only", default="", help="probar sólo paths que contengan este texto")
    ap.add_argument("--tier", default="reference", choices=["reference", "narrative", "all"])
    ap.add_argument("--max", type=int, default=0, help="límite de endpoints (0 = todos)")
    ap.add_argument("--concurrency", type=int, default=4)
    ap.add_argument("--timeout", type=float, default=8.0)
    ap.add_argument("--maxbytes", type=int, default=200_000)
    ap.add_argument("--db", default=DB)
    ap.add_argument("--out", default="verify-report.json")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    if not a.password and not a.dry_run:
        sys.exit("falta --password (o la variable de entorno HIK_PASSWORD)")

    con = sqlite3.connect(a.db)
    q = "SELECT method, path, tier, category, summary FROM endpoint WHERE method='GET'"
    if a.tier != "all":
        q += f" AND tier='{a.tier}'"
    rows = con.execute(q).fetchall()
    ops = [{"method": m, "path": p, "tier": t, "category": c, "summary": s}
           for m, p, t, c, s in rows]
    ops = [o for o in ops if not any(d.lower() in o["path"].lower() for d in DENY)]
    if a.only:
        ops = [o for o in ops if a.only.lower() in o["path"].lower()]

    params = dict(DEFAULT_PARAMS)
    for kv in a.param:
        k, _, v = kv.partition("=")
        params[k.strip()] = v.strip()

    channels = [c.strip() for c in a.channels.split(",") if c.strip()]
    plan = []
    for o in ops:
        if "{channelID}" in o["path"] and len(channels) > 1:
            for ch in channels:
                plan.append((o, {**params, "channelID": ch}))
        else:
            plan.append((o, {**params, "channelID": channels[0]}))
    if a.max:
        plan = plan[:a.max]

    base = f"http://{a.host}:{a.port}"
    print(f"{len(plan)} sondas GET contra {base}  (tier={a.tier}, canales={channels})",
          file=sys.stderr)
    if a.dry_run:
        for o, p in plan[:80]:
            print("  GET", fill(o["path"], p)[0])
        if len(plan) > 80:
            print(f"  ... y {len(plan)-80} más")
        return

    op_open = opener(base, a.user, a.password)
    results = []
    done = 0
    with ThreadPoolExecutor(max_workers=a.concurrency) as ex:
        futs = [ex.submit(probe, o, base, op_open, p, a.timeout, a.maxbytes)
                for o, p in plan]
        for f in futs:
            results.append(f.result())
            done += 1
            if done % 25 == 0:
                print(f"  {done}/{len(plan)}", file=sys.stderr)

    summary = {}
    for r in results:
        summary[r["result"]] = summary.get(r["result"], 0) + 1
    report = {"device": {"label": a.label or f"{a.host}:{a.port}", "host": a.host,
                         "port": a.port, "user": a.user},
              "when": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
              "channels": channels, "tier": a.tier,
              "summary": summary, "results": results}
    json.dump(report, open(a.out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(json.dumps(summary, indent=1), file=sys.stderr)
    print(f"-> {a.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
