#!/usr/bin/env python3
"""build_points.py — arma server/data/points.json indexado por deviceId de EventOS.

    python3 build_points.py --zones zones-raw.json \
        --config /opt/eventos/server/data/eventos.config.json \
        --out /opt/eventos/server/data/points.json

`zones-raw.json` es la extracción específica de Hikvision (clave
`slug:canal:kind:id`, la genera build_zones.py desde la auditoría ISAPI).
Este script la traduce a la identidad de EventOS: **deviceId**, que es único
entre clientes y marcas. Cuando entre otra marca, su adaptador escribe otro
`*-raw.json` con la misma forma y este script lo mezcla igual.

Deja además `aliases` (slug:canal → deviceId) por compatibilidad.
"""
import argparse, json, time

KIND = {"linedetection": "line", "fielddetection": "region",
        "regionentrance": "entrance", "regionexiting": "exiting"}


def devices(cfg):
    """Todos los objetos que parezcan dispositivos, vengan como vengan en la config."""
    out = []
    def walk(n):
        if isinstance(n, dict):
            if n.get("id") and ("channel" in n or n.get("type")):
                out.append(n)
            for v in n.values():
                walk(v)
        elif isinstance(n, list):
            for v in n:
                walk(v)
    walk(cfg)
    return out


def slug_of(dev):
    for t in (dev.get("tags") or []):
        t = str(t)
        if t.startswith("nvr:"):
            return t[4:]
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--zones", required=True, help="zones-raw.json (clave slug:canal:kind:id)")
    ap.add_argument("--config", required=True, help="eventos.config.json")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    raw = json.load(open(a.zones, encoding="utf-8"))["zones"]
    cfg = json.load(open(a.config, encoding="utf-8"))

    # (slug, canal) → deviceId
    index, aliases = {}, {}
    for d in devices(cfg):
        if d.get("type") == "nvr" or d.get("channel") is None:
            continue
        s = slug_of(d)
        if not s:
            continue
        key = (s, str(d["channel"]))
        index[key] = d["id"]
        aliases["%s:%s" % key] = d["id"]

    points, huerfanos = {}, []
    for k, z in raw.items():
        slug, ch, kind, rid = k.split(":", 3)
        dev = index.get((slug, ch))
        if not dev:
            huerfanos.append(k)
            continue
        ck = KIND.get(kind, kind)
        points.setdefault(dev, {})["%s:%s" % (ck, rid)] = {
            "name": z["name"], "kind": ck, "id": rid,
            "geometry": {"points": z["points"], "space": z.get("space", 1000),
                         "originBottomLeft": z.get("originBottomLeft", True)},
            "meta": {"vendor": "hikvision", "camera": z.get("camera"),
                     "target": z.get("target"), "sensitivity": z.get("sensitivity"),
                     "nvr": slug, "channel": int(ch)},
        }

    json.dump({"generated": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
               "source": a.zones, "points": points, "aliases": aliases},
              open(a.out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    n = sum(len(v) for v in points.values())
    print("%d puntos en %d dispositivos -> %s" % (n, len(points), a.out))
    if huerfanos:
        print("   %d sin dispositivo en EventOS (canal no dado de alta): %s"
              % (len(huerfanos), ", ".join(huerfanos[:6])))


if __name__ == "__main__":
    main()
