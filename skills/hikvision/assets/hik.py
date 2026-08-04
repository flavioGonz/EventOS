#!/usr/bin/env python3
"""hik — query the Hikvision ISAPI catalogue (endpoints, schemas, errors, fields).

Usage:
  hik.py find <text>...              search endpoints (path / summary / category)
  hik.py show <METHOD> <path>        full detail for one endpoint (+ schema refs)
  hik.py schema <name> [--family F]  print a component schema as JSON
  hik.py err <subStatusCode|0x...>   look up an ISAPI error / status code
  hik.py field <fieldName>           enum values documented for a field
  hik.py verified [--list RESULT]    que soporta de verdad cada equipo probado
  hik.py stats                       catalogue summary

The catalogue lives next to this script in ../openapi/catalog.sqlite.
"""
import json, os, sqlite3, sys, textwrap

HERE = os.path.dirname(os.path.abspath(__file__))
DB = os.environ.get("HIK_CATALOG") or os.path.join(HERE, "..", "openapi", "catalog.sqlite")
SPECDIR = os.path.join(HERE, "..", "openapi")


def con():
    if not os.path.exists(DB):
        sys.exit(f"catalogue not found: {DB}")
    return sqlite3.connect(DB)


def cmd_find(args):
    q = " ".join(args)
    c = con().cursor()
    fts = " ".join(f'"{t}"' for t in q.split())
    rows = c.execute(
        "SELECT e.method, e.path, e.tier, e.category, e.summary, e.families "
        "FROM endpoint_fts f JOIN endpoint e ON e.id=f.rowid "
        "WHERE endpoint_fts MATCH ? ORDER BY rank LIMIT 60", (fts,)).fetchall()
    if not rows:
        rows = c.execute(
            "SELECT method, path, tier, category, summary, families FROM endpoint "
            "WHERE path LIKE ? OR summary LIKE ? LIMIT 60",
            (f"%{q}%", f"%{q}%")).fetchall()
    for m, p, tier, cat, s, fams in rows:
        mark = "" if tier == "reference" else "  [narrative]"
        print(f"{m:6} {p}{mark}")
        if s:
            print(f"       {textwrap.shorten(s, 96)}")
        print(f"       {cat}  ·  {fams}")
    print(f"\n{len(rows)} result(s)")


def cmd_show(args):
    method, path = args[0].upper(), args[1]
    c = con().cursor()
    row = c.execute("SELECT id, tier, category, summary, params, schema_version "
                    "FROM endpoint WHERE method=? AND path=?", (method, path)).fetchone()
    if not row:
        like = c.execute("SELECT method, path FROM endpoint WHERE path LIKE ? LIMIT 10",
                         (f"%{path}%",)).fetchall()
        sys.exit("not found. did you mean:\n" + "\n".join(f"  {m} {p}" for m, p in like))
    eid, tier, cat, summary, params, ver = row
    print(f"{method} {path}\n{'=' * (len(method) + len(path) + 1)}")
    print(f"tier      : {tier}\ncategory  : {cat}\nsummary   : {summary}")
    print(f"params    : {', '.join(json.loads(params)) or '-'}")
    if ver:
        print(f"schema ver: {json.loads(ver)}")
    print("\ndocumented in:")
    for fam, opid, doc, sec, page, rq, rs, spec, ev in c.execute(
            "SELECT family, operation_id, document, section, page, request_root, "
            "response_root, spec, evidence FROM endpoint_family WHERE endpoint_id=?", (eid,)):
        print(f"  · {fam:11} {ev:9} §{sec or '-':10} p.{page or '-':<5} {doc or ''}")
        if opid:
            print(f"    operationId={opid}  spec={spec}")
        if rq:
            print(f"    request  <{rq}>")
        if rs:
            print(f"    response <{rs}>")
    try:
        ver = c.execute(
            "SELECT device, result, http, sub_status, root, checked_at FROM verification "
            "WHERE method=? AND path=?", (method, path)).fetchall()
    except sqlite3.OperationalError:
        ver = []
    if ver:
        print("\nverificado contra equipos reales:")
        for dev, res, http, sub, root, when in ver:
            extra = f" <{root}>" if root else ""
            extra += f" subStatus={sub}" if sub else ""
            print(f"  · {dev:24} {res:15} HTTP {http or '-'}{extra}   {when[:10]}")


def cmd_schema(args):
    name = args[0]
    fam = None
    if "--family" in args:
        fam = args[args.index("--family") + 1]
    c = con().cursor()
    q = "SELECT family, name, root, schema_version, json FROM schema_def WHERE name=?"
    p = [name]
    if fam:
        q += " AND family=?"
        p.append(fam)
    rows = c.execute(q, p).fetchall()
    if not rows:
        rows = c.execute("SELECT family, name, root, schema_version, json FROM schema_def "
                         "WHERE name LIKE ? LIMIT 5", (f"%{name}%",)).fetchall()
    for family, n, root, ver, js in rows[:3]:
        print(f"--- {n}  (family={family}, root={root}, ver={ver})")
        print(json.dumps(json.loads(js), indent=1, ensure_ascii=False))


def cmd_err(args):
    key = args[0]
    c = con().cursor()
    rows = c.execute(
        "SELECT status_code, status_string, sub_status_code, error_code, description "
        "FROM error_code WHERE sub_status_code=? OR error_code=? OR status_code=? "
        "OR sub_status_code LIKE ? LIMIT 40",
        (key, key, key, f"%{key}%")).fetchall()
    for sc, ss, sub, ec, de in rows:
        print(f"statusCode={sc:<4} {ss:<22} subStatusCode={sub:<34} errorCode={ec or '-':<12} {de or ''}")
    if not rows:
        print("no match")


def cmd_field(args):
    c = con().cursor()
    rows = c.execute("SELECT field, data_type, attr_type, value, value_desc, field_desc "
                     "FROM field WHERE field=? OR field LIKE ? LIMIT 200",
                     (args[0], f"%{args[0]}%")).fetchall()
    cur = None
    for f, dt, at, v, vd, fd in rows:
        if f != cur:
            cur = f
            print(f"\n{f}  ({dt}/{at})  — {fd or ''}")
        print(f"   {v:<28} {vd or ''}")
    if not rows:
        print("no match")


def cmd_verified(args):
    """Resumen de lo verificado contra equipos reales."""
    c = con().cursor()
    try:
        devs = c.execute("SELECT device, host, port, count(*) FROM verification "
                         "GROUP BY device").fetchall()
    except sqlite3.OperationalError:
        sys.exit("todavia no hay verificaciones: corre verify.py + ingest_verify.py")
    if not devs:
        sys.exit("todavia no hay verificaciones")
    for dev, host, port, n in devs:
        print(f"\n{dev}  ({host}:{port})  — {n} sondas")
        for res, k in c.execute("SELECT result, count(*) FROM verification "
                                "WHERE device=? GROUP BY result ORDER BY 2 DESC", (dev,)):
            print(f"   {res:16} {k}")
    if args and args[0] == "--list":
        want = args[1] if len(args) > 1 else "not_supported"
        print(f"\nendpoints con result={want}:")
        for m, p, dev in c.execute("SELECT method, path, device FROM verification "
                                   "WHERE result=? ORDER BY path", (want,)):
            print(f"  {m:6} {p}   [{dev}]")


def cmd_stats(_):
    c = con().cursor()
    print("endpoints by tier :", dict(c.execute(
        "SELECT tier, count(*) FROM endpoint GROUP BY tier").fetchall()))
    print("families          :")
    for k, t, spec, ep, ops, sch, doc in c.execute("SELECT * FROM family"):
        print(f"  {k:11} {ops:4} ops  {ep:4} paths  {sch:4} schemas   {t}")
    print("error codes       :", c.execute("SELECT count(*) FROM error_code").fetchone()[0])
    print("field enum values :", c.execute("SELECT count(*) FROM field").fetchone()[0])
    print("schemas total     :", c.execute("SELECT count(*) FROM schema_def").fetchone()[0])
    try:
        v = c.execute("SELECT result, count(*) FROM verification GROUP BY result").fetchall()
        if v:
            print("verificado en campo:", dict(v))
    except sqlite3.OperationalError:
        print("verificado en campo: (sin datos - corre verify.py)")


CMDS = {"find": cmd_find, "show": cmd_show, "schema": cmd_schema,
        "err": cmd_err, "field": cmd_field, "stats": cmd_stats,
        "verified": cmd_verified}

if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] not in CMDS:
        sys.exit(__doc__)
    CMDS[sys.argv[1]](sys.argv[2:])
