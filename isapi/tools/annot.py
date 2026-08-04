#!/usr/bin/env python3
"""Parse Hikvision ISAPI XML-sample annotation comments into structured metadata.

Grammar (comma separated, in order):
    [ro|rw|wo] , [req|opt] , <type> , <modifier:value>* , <free description>*
Modifiers seen in the manuals: subType, range, unit, step, dep, attr, def, min,
max, size, desc.  `attr:name{...}` describes an XML attribute of the element.
"""
import re

ACCESS = {"ro", "rw", "wo"}
PRESENCE = {"req", "opt"}
TYPES = {"int", "integer", "string", "bool", "boolean", "enum", "object", "array",
         "time", "float", "double", "binary", "base64", "date"}
MODKEYS = {"subType", "range", "unit", "step", "dep", "attr", "def", "min", "max",
           "size", "desc", "len", "length"}


def split_top(s):
    """Split on commas that are not inside {} [] ()."""
    out, depth, cur = [], 0, ""
    for ch in s:
        if ch in "{[(":
            depth += 1
        elif ch in "}])":
            depth -= 1
        if ch == "," and depth <= 0:
            out.append(cur.strip())
            cur = ""
        else:
            cur += ch
    if cur.strip():
        out.append(cur.strip())
    return out


RANGE_RE = re.compile(r'^range:\s*\[\s*([^,\]]*)\s*,\s*([^\]]*)\s*\]', re.I)
ATTR_RE = re.compile(r'^attr:\s*([A-Za-z_][\w\-.]*)\s*\{(.*)\}\s*$', re.S)
BARE_ATTR_RE = re.compile(r'^([A-Za-z_][\w\-.]*)\s*\{(.*)\}\s*$', re.S)


def parse(comment):
    """comment: raw text between <!-- and -->. Returns dict."""
    c = " ".join(comment.split())
    parts = split_top(c)
    r = {"access": None, "presence": None, "type": None, "subType": None,
         "range": None, "unit": None, "step": None, "dep": None,
         "attrs": {}, "default": None, "desc": None, "raw": c}
    desc_parts = []
    structured_done = False
    for i, p in enumerate(parts):
        if not p:
            continue
        low = p.lower()
        if not structured_done and low in ACCESS and r["access"] is None:
            r["access"] = low
            continue
        if not structured_done and low in PRESENCE and r["presence"] is None:
            r["presence"] = low
            continue
        if not structured_done and low in TYPES and r["type"] is None:
            r["type"] = low
            continue
        m = ATTR_RE.match(p) or BARE_ATTR_RE.match(p)
        if m:
            r["attrs"][m.group(1)] = parse(m.group(2))
            continue
        m = RANGE_RE.match(p)
        if m:
            r["range"] = [m.group(1).strip(), m.group(2).strip()]
            continue
        if ":" in p:
            k, v = p.split(":", 1)
            k, v = k.strip(), v.strip()
            if k in MODKEYS:
                if k == "desc":
                    desc_parts.append(v)
                    structured_done = True
                elif k == "subType":
                    r["subType"] = v
                elif k == "def":
                    r["default"] = v
                elif k in ("unit", "step", "dep"):
                    r[k] = v
                else:
                    r.setdefault("extra", {})[k] = v
                continue
        # anything else -> free-text description tail
        structured_done = True
        desc_parts.append(p)
    if desc_parts:
        r["desc"] = ", ".join(desc_parts).strip()
    if r["access"] is None:
        r["access"] = "rw"
    return r


JSON_TYPE = {
    "int": "integer", "integer": "integer", "float": "number", "double": "number",
    "string": "string", "time": "string", "date": "string", "bool": "boolean",
    "boolean": "boolean", "enum": "string", "object": "object", "array": "array",
    "binary": "string", "base64": "string",
}


def json_type(a):
    t = a.get("type")
    if t == "enum":
        st = (a.get("subType") or "string").lower()
        return JSON_TYPE.get(st, "string")
    return JSON_TYPE.get(t or "", "string")
