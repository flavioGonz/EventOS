#!/usr/bin/env python3
"""Extract clean, watermark-free, layout-aware text from Hikvision ISAPI PDFs.

Filters the rotated diagonal watermark, keeps monospace (code) vs prose
distinction, and preserves table column boundaries as tabs.
"""
import fitz, json, sys, os

GAP = 2.2  # pt gap that means "new cell / new word group"


def page_lines(page):
    d = page.get_text("dict")
    spans = []
    for b in d["blocks"]:
        if b["type"] != 0:
            continue
        for l in b["lines"]:
            dx, dy = l["dir"]
            if abs(dx - 1.0) > 0.01 or abs(dy) > 0.01:
                continue  # rotated watermark
            for s in l["spans"]:
                if not s["text"].strip():
                    continue
                spans.append({
                    "x0": s["bbox"][0], "x1": s["bbox"][2], "y": s["bbox"][1],
                    "t": s["text"], "font": s["font"], "size": round(s["size"], 1),
                })
    spans.sort(key=lambda r: (round(r["y"] / 2.0), r["x0"]))
    lines, cur = [], []
    for s in spans:
        if cur and abs(s["y"] - cur[0]["y"]) < 2.5:
            cur.append(s)
        else:
            if cur:
                lines.append(cur)
            cur = [s]
    if cur:
        lines.append(cur)

    out = []
    for grp in lines:
        grp.sort(key=lambda r: r["x0"])
        parts = []
        prev_x1 = None
        for s in grp:
            if prev_x1 is not None and s["x0"] - prev_x1 > GAP:
                parts.append("\t")
            parts.append(s["t"])
            prev_x1 = s["x1"]
        txt = "".join(parts)
        ismono = lambda s: ("Consolas" in s["font"] or "Courier" in s["font"])
        mono = all(ismono(s) for s in grp)
        amono = any(ismono(s) for s in grp)
        out.append({
            "x": round(grp[0]["x0"], 1),
            "y": round(grp[0]["y"], 1),
            "t": txt.rstrip(),
            "mono": mono,
            "amono": amono,
            "size": max(s["size"] for s in grp),
            "bold": any("Bold" in s["font"] for s in grp),
        })
    return out


def main(pdf, outjson):
    doc = fitz.open(pdf)
    pages = [{"page": i + 1, "lines": page_lines(p)} for i, p in enumerate(doc)]
    with open(outjson, "w", encoding="utf-8") as f:
        json.dump({"source": os.path.basename(pdf), "pages": pages}, f, ensure_ascii=False)
    print(f"{os.path.basename(pdf)}: {len(pages)} pages -> {outjson}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
