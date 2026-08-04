#!/usr/bin/env python3
"""Parse Hikvision ISAPI manual JSON (from extract.py) into structured operations."""
import json, re, sys, os

HEAD_RE = re.compile(r'^(\d+(?:\.\d+)*)\s+(\S.*)$')
METHOD_RE = re.compile(r'^(GET|PUT|POST|DELETE|HEAD|OPTIONS|PATCH)\s+(/\S*)\s*$')
LABELS = {"Request URL", "Query Parameter", "Request Message", "Response Message",
          "Remarks", "Note", "Notes", "Request Header", "Response Header",
          "Request Message Example", "Response Message Example", "Description",
          "Example", "Content-Type"}


def is_heading(l):
    if l["mono"] or not l["bold"]:
        return False
    if l["size"] < 11.5:
        return False
    return bool(HEAD_RE.match(l["t"].strip()))


def flatten(doc):
    out = []
    for p in doc["pages"]:
        for l in p["lines"]:
            l = dict(l)
            l["page"] = p["page"]
            out.append(l)
    return out


def parse(path):
    doc = json.load(open(path, encoding="utf-8"))
    lines = flatten(doc)
    ops = []
    stack = {}          # depth -> title
    cur = None          # current operation dict
    label = None
    for l in lines:
        t = l["t"].strip()
        if not t:
            continue
        if is_heading(l):
            m = HEAD_RE.match(t)
            num, title = m.group(1), m.group(2).strip()
            depth = num.count(".") + 1
            stack = {k: v for k, v in stack.items() if k < depth}
            stack[depth] = title
            stack_num = num
            cur = {
                "num": num, "title": title, "page": l["page"],
                "breadcrumb": [stack[k] for k in sorted(stack)],
                "urls": [], "query": [], "request": [], "response": [],
                "notes": [], "remarks": [],
            }
            ops.append(cur)
            label = None
            continue
        if cur is None:
            continue
        if not l["mono"] and t in LABELS:
            label = t
            continue
        if label == "Request URL":
            m = METHOD_RE.match(t)
            if m:
                cur["urls"].append({"method": m.group(1), "path": m.group(2)})
            elif t.startswith("/ISAPI") or t.startswith("/PSIA"):
                cur["urls"].append({"method": None, "path": t})
            elif cur["urls"] and not t[0].isspace() and " " not in t:
                # wrapped continuation of the previous URL line
                cur["urls"][-1]["path"] += t
            else:
                cur["notes"].append(t)
        elif label == "Query Parameter":
            if t == "None":
                continue
            cur["query"].append({"raw": t, "page": l["page"]})
        elif label in ("Request Message", "Request Message Example"):
            if t == "None" and not l["mono"]:
                continue
            cur["request"].append({"t": l["t"], "mono": l["mono"], "amono": l.get("amono", l["mono"]), "page": l["page"], "x": l["x"]})
        elif label in ("Response Message", "Response Message Example"):
            if t == "None" and not l["mono"]:
                continue
            cur["response"].append({"t": l["t"], "mono": l["mono"], "amono": l.get("amono", l["mono"]), "page": l["page"], "x": l["x"]})
        elif label in ("Remarks", "Note", "Notes", "Description"):
            cur["remarks"].append(t)
        else:
            cur["notes"].append(t)
    # keep only sections that actually define an API
    api = [o for o in ops if o["urls"]]
    return {"source": doc["source"], "sections": ops, "operations": api}


if __name__ == "__main__":
    r = parse(sys.argv[1])
    json.dump(r, open(sys.argv[2], "w", encoding="utf-8"), ensure_ascii=False)
    print(f"{r['source']}: {len(r['sections'])} sections, {len(r['operations'])} API ops -> {sys.argv[2]}")
