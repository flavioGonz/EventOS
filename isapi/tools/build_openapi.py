#!/usr/bin/env python3
"""Build OpenAPI 3.1 specs + a cross-family catalogue from the parsed ISAPI manuals."""
import json, re, os, sys, hashlib, collections
import xmlblocks as X
import schemagen

FAMILIES = {
    "ipc-value":  {"title": "Network Cameras · Value Series",
                   "devices": ["IP camera (Value series)"]},
    "deepinview": {"title": "Network Cameras · DeepinView Series",
                   "devices": ["IP camera (DeepinView / AI series)"]},
    "anpr":       {"title": "Vehicle Access Control Management · ANPR Cameras",
                   "devices": ["ANPR / traffic camera", "entrance & exit station"]},
    "dvr-pro":    {"title": "DVR · Pro Series with AcuSense",
                   "devices": ["DVR/NVR Pro with AcuSense"]},
    "dvr-value":  {"title": "DVR · Value Series",
                   "devices": ["DVR/NVR Value series"]},
}

ANGLE = re.compile(r"<([A-Za-z_][\w\-.]*)>")
TABLE_HEADER = re.compile(r"^Parameter\s*Name\b", re.I)


# --------------------------------------------------------------------------- #
# path handling
# --------------------------------------------------------------------------- #
def split_path(raw):
    """Return (openapi_path, path_params, query_params)."""
    raw = raw.strip()
    q = ""
    if "?" in raw:
        raw, q = raw.split("?", 1)
    # `<name>` -> `{name}`, renaming repeats (OpenAPI forbids duplicate names)
    seen, fixed = {}, []

    def _sub(m):
        n = m.group(1)
        seen[n] = seen.get(n, 0) + 1
        final = n if seen[n] == 1 else f"{n}{seen[n]}"
        fixed.append(final)
        return "{" + final + "}"

    path = ANGLE.sub(_sub, raw)
    path_params = fixed
    query = []
    if q:
        for item in q.split("&"):
            if not item:
                continue
            k, _, v = item.partition("=")
            k = k.strip()
            if not k:
                continue
            m = ANGLE.fullmatch(v.strip())
            query.append({"name": k, "example": None if m else (v.strip() or None)})
    return path, fixed, query


def parse_query_table(rows):
    """Query Parameter table rows -> {name: description}."""
    out = {}
    for r in rows:
        t = r["raw"] if isinstance(r, dict) else r
        if TABLE_HEADER.match(t.strip()):
            continue
        cells = [c.strip() for c in t.split("\t")]
        if not cells or not cells[0]:
            continue
        name = cells[0]
        if not re.fullmatch(r"[A-Za-z_][\w\-.]*", name):
            continue
        typ = cells[1] if len(cells) > 1 else "string"
        desc = cells[2] if len(cells) > 2 else ""
        out[name] = {"type": typ, "desc": "" if desc in ("--", "-") else desc}
    return out


TYPE_MAP = {"string": "string", "int": "integer", "integer": "integer",
            "bool": "boolean", "boolean": "boolean", "float": "number",
            "double": "number", "enum": "string", "time": "string"}


# --------------------------------------------------------------------------- #
# operation id
# --------------------------------------------------------------------------- #
def make_op_id(method, path, used):
    tokens = [t for t in re.split(r"[/{}\-.]", path) if t and t.upper() != "ISAPI"]
    name = method.lower() + "".join(t[:1].upper() + t[1:] for t in tokens)
    name = re.sub(r"\W", "", name)
    base, i = name, 2
    while name in used:
        name = f"{base}_{i}"
        i += 1
    used.add(name)
    return name


# --------------------------------------------------------------------------- #
# schema registry (dedupe + $ref)
# --------------------------------------------------------------------------- #
class Registry:
    def __init__(self):
        self.by_hash = {}
        self.schemas = {}
        self.names = collections.Counter()

    def add(self, schema, hint):
        blob = json.dumps(schema, sort_keys=True, ensure_ascii=False)
        h = hashlib.sha1(blob.encode()).hexdigest()
        if h in self.by_hash:
            return self.by_hash[h]
        base = re.sub(r"\W", "", hint) or "Schema"
        self.names[base] += 1
        name = base if self.names[base] == 1 else f"{base}_v{self.names[base]}"
        self.schemas[name] = schema
        self.by_hash[h] = name
        return name


def body_schemas(entries, fields, reg, hint_prefix):
    """Return list of {media_type, schema_ref|schema, root}."""
    out = []
    for doc in X.split_docs(X.collect(entries)):
        if not doc.strip():
            continue
        if X.is_json(doc):
            try:
                sample = json.loads(doc)
            except Exception:
                sample = None
            sch = {"type": "object", "x-hik-json-sample": doc[:4000]}
            if isinstance(sample, dict):
                sch["examples"] = [sample]
            out.append({"media": "application/json", "schema": sch, "root": None})
            continue
        root, recovered = X.parse_xml(doc)
        if root is None:
            continue
        sch = schemagen.root_schema(root, fields)
        if recovered:
            sch["x-hik-parse"] = "recovered"
        rootname = sch.get("x-hik-root") or hint_prefix
        ref = reg.add(sch, rootname)
        out.append({"media": "application/xml", "ref": ref, "root": rootname})
    return out


def content_for(bodies):
    content = {}
    for b in bodies:
        if "ref" in b:
            content.setdefault(b["media"], {})["schema"] = {
                "$ref": f"#/components/schemas/{b['ref']}"}
        else:
            content.setdefault(b["media"], {})["schema"] = b["schema"]
    return content


# --------------------------------------------------------------------------- #
def build_family(key, parsed, fields):
    meta = FAMILIES[key]
    reg = Registry()
    paths = {}
    used_ids = set()
    catalog = []
    for o in parsed["operations"]:
        u = o["urls"][0]
        method = (u["method"] or "GET").lower()
        oapi_path, path_params, url_query = split_path(u["path"])
        qtable = parse_query_table(o["query"])

        params = []
        for p in path_params:
            info = qtable.pop(p, None) or qtable.pop(re.sub(r"\d+$", "", p), None)
            params.append({
                "name": p, "in": "path", "required": True,
                "schema": {"type": TYPE_MAP.get((info or {}).get("type", "string"), "string")},
                **({"description": info["desc"]} if info and info.get("desc") else {}),
            })
        for q in url_query:
            info = qtable.pop(q["name"], None)
            prm = {"name": q["name"], "in": "query", "required": False,
                   "schema": {"type": TYPE_MAP.get((info or {}).get("type", "string"), "string")}}
            if q.get("example"):
                prm["example"] = q["example"]
            if info and info.get("desc"):
                prm["description"] = info["desc"]
            params.append(prm)
        for name, info in qtable.items():
            params.append({"name": name, "in": "query", "required": False,
                           "schema": {"type": TYPE_MAP.get(info.get("type", "string"), "string")},
                           **({"description": info["desc"]} if info.get("desc") else {})})

        req = body_schemas(o["request"], fields, reg, "Request")
        res = body_schemas(o["response"], fields, reg, "Response")

        op = {
            "operationId": make_op_id(method, oapi_path, used_ids),
            "summary": o["title"],
            "tags": [o["breadcrumb"][1] if len(o["breadcrumb"]) > 1 else o["breadcrumb"][0]],
            "x-hik-section": o["num"],
            "x-hik-source": {"document": parsed["source"], "section": o["num"],
                             "page": o["page"], "breadcrumb": o["breadcrumb"]},
            "x-hik-family": key,
            "x-hik-devices": meta["devices"],
        }
        if o.get("remarks"):
            op["description"] = "\n".join(o["remarks"])
        if params:
            op["parameters"] = params
        if req:
            op["requestBody"] = {"required": True, "content": content_for(req)}
        responses = {"200": {"description": "OK"}}
        if res:
            responses["200"]["content"] = content_for(res)
        else:
            responses["200"]["description"] = "OK (binary or empty payload)"
        responses["default"] = {
            "description": "ISAPI error — see ResponseStatus statusCode/subStatusCode",
            "content": {"application/xml": {"schema": {"$ref": "#/components/schemas/ResponseStatus"}}},
        }
        op["responses"] = responses
        vers = sorted({b.get("root") and reg.schemas[b["ref"]].get("x-hik-schema-version")
                       for b in (req + res) if b.get("ref")} - {None})
        if vers:
            op["x-hik-schema-version"] = vers[0] if len(vers) == 1 else vers

        slot = paths.setdefault(oapi_path, {})
        if method in slot:
            slot[method].setdefault("x-hik-also-documented-in", []).append(
                {"section": o["num"], "title": o["title"], "page": o["page"]})
        else:
            slot[method] = op
        catalog.append({
            "family": key, "method": method.upper(), "path": oapi_path,
            "raw_path": u["path"], "operationId": op["operationId"],
            "summary": o["title"], "section": o["num"], "page": o["page"],
            "breadcrumb": o["breadcrumb"], "document": parsed["source"],
            "request_roots": [b.get("root") for b in req if b.get("root")],
            "response_roots": [b.get("root") for b in res if b.get("root")],
            "schema_version": op.get("x-hik-schema-version"),
            "parameters": [p["name"] for p in params],
        })

    if "ResponseStatus" not in reg.schemas:
        reg.schemas["ResponseStatus"] = DEFAULT_RESPONSE_STATUS

    spec = {
        "openapi": "3.1.0",
        "info": {
            "title": f"Hikvision ISAPI — {meta['title']}",
            "version": "1.0.0",
            "summary": "Machine-readable ISAPI surface generated from the official Hikvision manual.",
            "description": (
                f"Generated from **{parsed['source']}**.\n\n"
                "Every operation carries `x-hik-source` (document, section number, page) so any\n"
                "entry can be traced back to the manual. Authentication is HTTP **Digest**.\n"
                "Bodies are XML unless a JSON media type is shown.\n"),
            "x-hik-document": parsed["source"],
            "x-hik-family": key,
            "x-hik-devices": meta["devices"],
        },
        "servers": [{
            "url": "http://{host}:{port}",
            "variables": {"host": {"default": "192.168.1.64"},
                          "port": {"default": "80",
                                   "description": "ISAPI HTTP port — NOT the 8000 SDK port"}},
        }],
        "security": [{"digestAuth": []}],
        "components": {
            "securitySchemes": {"digestAuth": {"type": "http", "scheme": "digest"}},
            "schemas": reg.schemas,
        },
        "paths": paths,
    }
    return spec, catalog


DEFAULT_RESPONSE_STATUS = {
    "type": "object", "xml": {"name": "ResponseStatus"},
    "description": "Standard ISAPI status envelope.",
    "properties": {
        "requestURL": {"type": "string", "readOnly": True, "xml": {"name": "requestURL"}},
        "statusCode": {"type": "integer", "readOnly": True, "xml": {"name": "statusCode"}},
        "statusString": {"type": "string", "readOnly": True, "xml": {"name": "statusString"}},
        "subStatusCode": {"type": "string", "readOnly": True, "xml": {"name": "subStatusCode"}},
        "errorCode": {"type": "integer", "readOnly": True, "xml": {"name": "errorCode"}},
        "errorMsg": {"type": "string", "readOnly": True, "xml": {"name": "errorMsg"}},
    },
    "required": ["statusCode", "statusString"],
}


def main(outdir, builddir="out"):
    fields = json.load(open(os.path.join(builddir, "field-dictionary.json"), encoding="utf-8"))
    os.makedirs(outdir, exist_ok=True)
    os.makedirs(builddir, exist_ok=True)
    all_catalog = []
    import yaml
    for key in FAMILIES:
        parsed = json.load(open(os.path.join(builddir, f"{key}.parsed.json"), encoding="utf-8"))
        spec, cat = build_family(key, parsed, fields)
        with open(os.path.join(outdir, f"{key}.yaml"), "w", encoding="utf-8") as f:
            yaml.safe_dump(spec, f, allow_unicode=True, sort_keys=False, width=120)
        with open(os.path.join(builddir, f"{key}.json"), "w", encoding="utf-8") as f:
            json.dump(spec, f, ensure_ascii=False, indent=1)
        all_catalog += cat
        print(f"{key}: {len(spec['paths'])} paths, "
              f"{sum(len(v) for v in spec['paths'].values())} operations, "
              f"{len(spec['components']['schemas'])} schemas")
    json.dump(all_catalog, open(os.path.join(builddir, "catalog-raw.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    print("catalog entries:", len(all_catalog))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "openapi",
         sys.argv[2] if len(sys.argv) > 2 else "out")
