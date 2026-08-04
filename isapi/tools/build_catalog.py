#!/usr/bin/env python3
"""Build the cross-family ISAPI catalogue: catalog.json + catalog.sqlite."""
import json, os, re, sqlite3, sys, collections

ANGLE = re.compile(r"<([A-Za-z_][\w\-.]*)>")
FAMILY_TITLES = {
    "ipc-value": "Network Cameras · Value Series",
    "deepinview": "Network Cameras · DeepinView Series",
    "anpr": "Vehicle Access Control Management · ANPR Cameras",
    "dvr-pro": "DVR · Pro Series with AcuSense",
    "dvr-value": "DVR · Value Series",
}


def templated(p):
    return ANGLE.sub(lambda m: "{" + m.group(1) + "}", p.split("?")[0])


def usable_narrative(path):
    if not path.startswith(("/ISAPI/", "/PSIA/")):
        return False
    if any(ord(c) > 127 for c in path):
        return False
    if path.endswith(("/", "-", "_", "=", "&")):
        return False
    if len(path) < 10:
        return False
    return True


def main(specdir, outdir, builddir="out"):
    os.makedirs(outdir, exist_ok=True)
    raw = json.load(open(os.path.join(builddir, "catalog-raw.json"), encoding="utf-8"))
    narrative = json.load(open(os.path.join(builddir, "narrative-endpoints.json"), encoding="utf-8"))

    entries = collections.OrderedDict()   # (METHOD, path) -> entry
    for e in raw:
        key = (e["method"], e["path"])
        ent = entries.setdefault(key, {
            "method": e["method"], "path": e["path"], "tier": "reference",
            "summary": e["summary"], "families": {}, "parameters": e["parameters"],
            "schema_version": e.get("schema_version"),
            "category": e["breadcrumb"][1] if len(e["breadcrumb"]) > 1 else e["breadcrumb"][0],
            "verified": None,
        })
        ent["families"][e["family"]] = {
            "operationId": e["operationId"], "document": e["document"],
            "section": e["section"], "page": e["page"], "summary": e["summary"],
            "request_roots": e["request_roots"], "response_roots": e["response_roots"],
            "spec": f"{e['family']}.yaml",
        }

    for fam, items in narrative.items():
        for e in items:
            path = templated(e["path"])
            if not usable_narrative(path):
                continue
            key = (e["method"], path)
            if key in entries:
                entries[key]["families"].setdefault(fam, {}).setdefault("mentioned_pages", e["pages"])
                continue
            ent = entries.setdefault(key, {
                "method": e["method"], "path": path, "tier": "narrative",
                "summary": (e["context"][0] if e["context"] else "").strip()[:300],
                "families": {}, "parameters": ANGLE.findall(e["path"]),
                "schema_version": None, "category": "Narrative / Quick Start",
                "verified": None,
            })
            ent["families"][fam] = {"mentioned_pages": e["pages"],
                                    "headings": e.get("headings", [])[:3],
                                    "context": e["context"][:2]}

    catalog = {
        "generated_from": sorted({f["document"] for e in entries.values()
                                  for f in e["families"].values() if f.get("document")}),
        "families": {k: {"title": v, "spec": f"{k}.yaml"} for k, v in FAMILY_TITLES.items()},
        "counts": {
            "endpoints": len(entries),
            "reference": sum(1 for e in entries.values() if e["tier"] == "reference"),
            "narrative": sum(1 for e in entries.values() if e["tier"] == "narrative"),
        },
        "endpoints": list(entries.values()),
    }
    json.dump(catalog, open(os.path.join(outdir, "catalog.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)

    # ---------------- sqlite -------------------------------------------- #
    db = os.path.join(outdir, "catalog.sqlite")
    if os.path.exists(db):
        os.remove(db)
    con = sqlite3.connect(db)
    c = con.cursor()
    c.executescript("""
    CREATE TABLE endpoint (
      id INTEGER PRIMARY KEY, method TEXT, path TEXT, tier TEXT,
      category TEXT, summary TEXT, schema_version TEXT, params TEXT,
      families TEXT, verified TEXT, verified_note TEXT,
      UNIQUE(method, path));
    CREATE TABLE endpoint_family (
      endpoint_id INTEGER, family TEXT, operation_id TEXT, document TEXT,
      section TEXT, page INTEGER, request_root TEXT, response_root TEXT,
      spec TEXT, evidence TEXT);
    CREATE TABLE family (key TEXT PRIMARY KEY, title TEXT, spec TEXT,
      endpoints INTEGER, operations INTEGER, schemas INTEGER, document TEXT);
    CREATE TABLE error_code (status_code TEXT, status_string TEXT,
      sub_status_code TEXT, error_code TEXT, description TEXT);
    CREATE TABLE field (field TEXT, data_type TEXT, attr_type TEXT,
      value TEXT, value_desc TEXT, field_desc TEXT);
    CREATE TABLE schema_def (family TEXT, name TEXT, root TEXT,
      schema_version TEXT, json TEXT);
    CREATE VIRTUAL TABLE endpoint_fts USING fts5(
      method, path, summary, category, families, content='');
    CREATE INDEX idx_ep_path ON endpoint(path);
    CREATE INDEX idx_epf ON endpoint_family(endpoint_id);
    CREATE INDEX idx_field ON field(field);
    CREATE INDEX idx_err ON error_code(sub_status_code);
    """)
    for i, e in enumerate(catalog["endpoints"], 1):
        fams = ",".join(sorted(e["families"]))
        c.execute("INSERT INTO endpoint VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                  (i, e["method"], e["path"], e["tier"], e["category"], e["summary"],
                   json.dumps(e["schema_version"]) if e["schema_version"] else None,
                   json.dumps(e["parameters"]), fams, None, None))
        c.execute("INSERT INTO endpoint_fts(rowid, method, path, summary, category, families)"
                  " VALUES (?,?,?,?,?,?)",
                  (i, e["method"], e["path"], e["summary"] or "", e["category"], fams))
        for fam, f in e["families"].items():
            c.execute("INSERT INTO endpoint_family VALUES (?,?,?,?,?,?,?,?,?,?)",
                      (i, fam, f.get("operationId"), f.get("document"), f.get("section"),
                       (f.get("page") or (f.get("mentioned_pages") or [None])[0]),
                       ",".join(f.get("request_roots") or []),
                       ",".join(f.get("response_roots") or []),
                       f.get("spec"), "reference" if f.get("section") else "narrative"))

    for key, title in FAMILY_TITLES.items():
        spec = json.load(open(os.path.join(builddir, f"{key}.json"), encoding="utf-8"))
        nops = sum(len(v) for v in spec["paths"].values())
        c.execute("INSERT INTO family VALUES (?,?,?,?,?,?,?)",
                  (key, title, f"{key}.yaml", len(spec["paths"]), nops,
                   len(spec["components"]["schemas"]), spec["info"]["x-hik-document"]))
        for name, sch in spec["components"]["schemas"].items():
            c.execute("INSERT INTO schema_def VALUES (?,?,?,?,?)",
                      (key, name, sch.get("x-hik-root"), sch.get("x-hik-schema-version"),
                       json.dumps(sch, ensure_ascii=False)))

    for e in json.load(open(os.path.join(builddir, "error-codes.json"), encoding="utf-8")):
        c.execute("INSERT INTO error_code VALUES (?,?,?,?,?)",
                  (e["statusCode"], e["statusString"], e["subStatusCode"],
                   e["errorCode"], e["description"]))
    fields = json.load(open(os.path.join(builddir, "field-dictionary.json"), encoding="utf-8"))
    for fname, vals in fields.items():
        for v in vals:
            c.execute("INSERT INTO field VALUES (?,?,?,?,?,?)",
                      (fname, v.get("type"), v.get("subType"), v.get("value"),
                       v.get("desc"), v.get("field_desc")))
    con.commit()
    c.execute("VACUUM")
    con.close()
    print(f"catalog: {catalog['counts']} -> {outdir}/catalog.json + catalog.sqlite")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "openapi",
         sys.argv[2] if len(sys.argv) > 2 else "openapi",
         sys.argv[3] if len(sys.argv) > 3 else "out")
