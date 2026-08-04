#!/usr/bin/env python3
"""ingest_verify.py — mete los reportes de verify.py dentro del catálogo.

    python3 ingest_verify.py verify-srv1.json verify-srv2.json

Crea/actualiza la tabla `verification` (una fila por endpoint y equipo) y
actualiza la columna `endpoint.verified` con el mejor resultado observado.
Después, `hik.py show` muestra qué equipos lo soportan de verdad.
"""
import json, os, sqlite3, sys

HERE = os.path.dirname(os.path.abspath(__file__))
DB = os.environ.get("HIK_CATALOG") or os.path.join(HERE, "..", "openapi", "catalog.sqlite")

RANK = {"supported": 4, "error_response": 3, "not_supported": 2,
        "absent": 1, "auth_failed": 0, "error": 0, "skipped_params": 0}


def main(files):
    con = sqlite3.connect(DB)
    c = con.cursor()
    c.executescript("""
    CREATE TABLE IF NOT EXISTS verification (
      method TEXT, path TEXT, device TEXT, host TEXT, port INTEGER,
      result TEXT, http INTEGER, sub_status TEXT, root TEXT,
      content_type TEXT, ms INTEGER, checked_at TEXT,
      UNIQUE(method, path, device));
    CREATE INDEX IF NOT EXISTS idx_ver ON verification(method, path);
    """)
    total = 0
    for f in files:
        rep = json.load(open(f, encoding="utf-8"))
        dev, when = rep["device"], rep["when"]
        for r in rep["results"]:
            c.execute(
                "INSERT OR REPLACE INTO verification VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                (r.get("method", "GET"), r["path"], dev["label"], dev["host"], dev["port"],
                 r["result"], r.get("http"), r.get("subStatusCode"), r.get("root"),
                 r.get("content_type"), r.get("ms"), when))
            total += 1
        print(f"{f}: {len(rep['results'])} sondas de {dev['label']}")

    # mejor resultado por endpoint -> endpoint.verified
    rows = c.execute("SELECT method, path, device, result FROM verification").fetchall()
    best = {}
    for m, p, dev, res in rows:
        k = (m, p)
        if RANK.get(res, 0) >= RANK.get(best.get(k, ("", ""))[1] if k in best else "", -1):
            if k not in best or RANK.get(res, 0) > RANK.get(best[k][1], -1):
                best[k] = (dev, res)
    for (m, p), (dev, res) in best.items():
        c.execute("UPDATE endpoint SET verified=?, verified_note=? WHERE method=? AND path=?",
                  (res, dev, m, p))
    con.commit()
    con.close()
    print(f"\n{total} sondas ingeridas · {len(best)} endpoints marcados en el catálogo")
    print("Probá:  python3 hik.py show GET /ISAPI/System/capabilities")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    main(sys.argv[1:])
