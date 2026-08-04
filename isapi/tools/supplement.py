#!/usr/bin/env python3
"""Mine endpoints that are only mentioned narratively (Quick Start chapters,
notes, examples) and are therefore absent from the formal API Reference."""
import json, re, sys, collections

CALL_RE = re.compile(
    r"\b(GET|PUT|POST|DELETE|HEAD|OPTIONS)\s+(/(?:ISAPI|PSIA|SDK)/[^\s'\"<>,;)\]]*)")
URL_RE = re.compile(r"(?:https?://[^/\s]+)?(/(?:ISAPI|PSIA)/[^\s'\"<>,;)\]]*)")
HEAD_RE = re.compile(r"^(\d+(?:\.\d+)*)\s+(\S.*)$")
TRAILING = ".,;:)]}'\"`"


def clean(p):
    p = p.rstrip(TRAILING)
    p = p.split("HTTP/")[0].strip().rstrip(TRAILING)
    return p


def mine(rawpath, api_ref_chapter=None):
    doc = json.load(open(rawpath, encoding="utf-8"))
    hits = collections.OrderedDict()
    heading = None
    for p in doc["pages"]:
        for l in p["lines"]:
            t = l["t"].strip()
            if not t:
                continue
            if not l["mono"] and l.get("bold") and HEAD_RE.match(t):
                heading = HEAD_RE.match(t).group(0)
            for m in CALL_RE.finditer(t):
                method, path = m.group(1), clean(m.group(2))
                if len(path) < 8:
                    continue
                key = (method, path)
                e = hits.setdefault(key, {"method": method, "path": path,
                                          "pages": [], "context": [], "headings": []})
                if p["page"] not in e["pages"]:
                    e["pages"].append(p["page"])
                if heading and heading not in e["headings"]:
                    e["headings"].append(heading)
                if len(e["context"]) < 3 and not l["mono"]:
                    e["context"].append(" ".join(t.split())[:400])
    return list(hits.values())


if __name__ == "__main__":
    import os
    BUILD = os.environ.get("HIK_BUILD", "out")
    RAW = os.path.join(BUILD, "raw")
    out = {}
    for key in ["ipc-value", "deepinview", "anpr", "dvr-pro", "dvr-value"]:
        out[key] = mine(os.path.join(RAW, f"{key}.json"))
        print(f"{key}: {len(out[key])} narrative endpoint mentions")
    json.dump(out, open(os.path.join(BUILD, "narrative-endpoints.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
