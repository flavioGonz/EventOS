#!/usr/bin/env python3
"""build_zones.py — audit.json → zones.json (mapa regionID → zona real).

    python3 build_zones.py /tmp/audit.json server/data/zones.json

Lee las reglas realmente dibujadas en cada cámara (geometría, objetivo IA,
sensibilidad) y arma el índice `slug:canal:tipo:ruleId` que consume
server/src/events/zones.js para que un evento diga "Carga · zona" en vez de
"Región 1". Regenerar cada vez que se dibujen o cambien reglas.
"""
import json, re, sys, time

SLUG = {82: "srv2", 83: "srv1"}
TYPES = [("line_rules", "LineItem", "linedetection", "línea"),
         ("field_rules", "FieldDetectionRegion", "fielddetection", "zona"),
         ("entrance_rules", "RegionEntranceRegion", "regionentrance", "entrada"),
         ("exiting_rules", "RegionExitingRegion", "regionexiting", "salida")]


def coords(block):
    pts = []
    for c in re.findall(r"<(?:Region)?Coordinates>(.*?)</(?:Region)?Coordinates>", block, re.S):
        x = re.search(r"<positionX>(\d+)</positionX>", c)
        y = re.search(r"<positionY>(\d+)</positionY>", c)
        if x and y:
            pts.append([int(x.group(1)), int(y.group(1))])
    return pts


def build(audit):
    zones = {}
    for a in audit["audits"]:
        slug = SLUG.get(a["device"]["port"]) or "p%s" % a["device"]["port"]
        names = {}
        for b in re.findall(r"<InputProxyChannel>(.*?)</InputProxyChannel>",
                            a["device_level"]["input_proxy"]["xml"], re.S):
            i = re.search(r"<id>(\d+)</id>", b)
            n = re.search(r"<name>(.*?)</name>", b)
            if i:
                names[i.group(1)] = n.group(1) if n else ""
        for ch, e in a["channels"].items():
            cam = names.get(ch, "") or "Canal %s" % ch
            for key, tag, evkey, label in TYPES:
                blk = e.get(key)
                if not blk or blk["http"] != 200:
                    continue
                live = []
                for it in re.findall(r"<%s>(.*?)</%s>" % (tag, tag), blk["xml"], re.S):
                    if tag == "LineItem" and "<enabled>true</enabled>" not in it:
                        continue
                    pts = coords(it)
                    if not pts:
                        continue
                    rid = re.search(r"<id>(\d+)</id>", it)
                    tgt = re.search(r"<detectionTarget>(.*?)</detectionTarget>", it)
                    sen = re.search(r"<sensitivityLevel>(\d+)</sensitivityLevel>", it)
                    live.append({"id": rid.group(1) if rid else str(len(live) + 1), "points": pts,
                                 "target": tgt.group(1) if tgt else None,
                                 "sensitivity": int(sen.group(1)) if sen else None})
                for r in live:
                    nm = "%s · %s" % (cam, label) + ((" %s" % r["id"]) if len(live) > 1 else "")
                    zones["%s:%s:%s:%s" % (slug, ch, evkey, r["id"])] = {
                        "name": nm, "camera": cam, "nvr": slug, "channel": int(ch),
                        "kind": evkey, "label": label, "ruleId": r["id"],
                        "target": r["target"], "sensitivity": r["sensitivity"],
                        "points": r["points"], "space": 1000, "originBottomLeft": True}
    return zones


if __name__ == "__main__":
    src = sys.argv[1] if len(sys.argv) > 1 else "audit.json"
    dst = sys.argv[2] if len(sys.argv) > 2 else "zones.json"
    z = build(json.load(open(src, encoding="utf-8")))
    json.dump({"generated": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
               "source": src,
               "note": "Coordenadas normalizadas 0-1000, origen abajo-izquierda: invertir Y para dibujar.",
               "zones": z}, open(dst, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    cams = len({v["nvr"] + str(v["channel"]) for v in z.values()})
    print("%d zonas en %d cámaras -> %s" % (len(z), cams, dst))
