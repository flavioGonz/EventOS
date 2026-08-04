#!/usr/bin/env python3
"""Reconstruct and clean the annotated XML/JSON sample blocks of an ISAPI section."""
import re
from difflib import SequenceMatcher
from lxml import etree

CODE_START = ("<", "{", "[")

# A few glyphs (mainly '.' and '"') are mis-decoded as spaces by the PDF text
# layer, and some lines are drawn twice (once damaged).  These helpers repair it.
ROOT_RE = re.compile(
    r'^\s*<([A-Za-z_][\w\-.]*)\s+xmlns\s*=\s*"?\s*(http[^"]*?XMLSchema)"?\s+version\s*=\s*"?\s*([\d\s.]+?)"?\s*>\s*$')


def _sig(s):
    return re.sub(r"\s+", "", s)


def _is_subseq(a, b):
    it = iter(b)
    return all(c in it for c in a)


def normalize_root(line):
    m = ROOT_RE.match(line)
    if not m:
        return line
    tag, ns, ver = m.group(1), m.group(2), m.group(3)
    ns = re.sub(r"\s+", ".", ns.strip())
    ns = re.sub(r"http:/+", "http://", ns)
    if "www.isapi" not in ns and "isapi" in ns:
        ns = re.sub(r"www[ .]?isapi[ .]?org", "www.isapi.org", ns)
    ver = ver.strip().replace(" ", ".")
    return f'<{tag} xmlns="{ns}" version="{ver}">'


TAG_OK = re.compile(r'^\s*</?[A-Za-z_][\w\-.:]*(\s+[\w\-.:]+\s*=\s*"[^"]*")*\s*/?>\s*\S*\s*$')
COMMENT_OK = re.compile(r'^\s*<!--.*?-->.*$', re.S)
DECL_OK = re.compile(r'^\s*<\?xml\b.*\?>\s*$')


def plausible(line):
    """True if the line looks like syntactically sane XML (or plain text)."""
    s = line.strip()
    if not s:
        return True
    if not s.startswith("<"):
        return True                      # element text content
    return bool(TAG_OK.match(s) or COMMENT_OK.match(s) or DECL_OK.match(s))


def dedupe_ghosts(lines):
    """Drop lines that are *damaged* duplicates of an adjacent line.

    The PDF sometimes draws a line twice, the second time with glyphs decoded as
    spaces (`<endTime>` -> `<e d e>`).  Only implausible lines are ever dropped,
    so legitimate pairs such as `</X>` / `</XList>` are preserved.
    """
    keep = [True] * len(lines)
    for i, li in enumerate(lines):
        if plausible(li):
            continue
        a = _sig(li)
        if not a:
            continue
        for j in (i - 1, i + 1):
            if j < 0 or j >= len(lines) or not keep[j]:
                continue
            lj = lines[j]
            if not plausible(lj):
                continue
            b = _sig(lj)
            if not b or a == b:
                continue
            if (_is_subseq(a, b) and len(a) >= 0.5 * len(b)) or \
               SequenceMatcher(None, a, b).ratio() > 0.8:
                keep[i] = False
                break
    return [l for i, l in enumerate(lines) if keep[i]]


def collect(entries):
    """entries: list of {t, mono, amono, page}. Returns cleaned source text."""
    lines, prev_page, prev_txt = [], None, None
    for e in entries:
        t = e["t"]
        s = t.strip()
        if not s:
            continue
        if not (e.get("amono") or e.get("mono") or s.startswith(CODE_START)):
            continue
        # PDF page-break artifact: the last code line is repeated at the top of
        # the next page.  Drop the duplicate.
        if prev_page is not None and e["page"] != prev_page and s == prev_txt:
            prev_page = e["page"]
            continue
        lines.append(normalize_root(t.replace("\t", " ")))
        prev_page, prev_txt = e["page"], s
    return "\n".join(dedupe_ghosts(lines))


def split_docs(txt):
    idx = [m.start() for m in re.finditer(r"<\?xml", txt)]
    if not idx:
        return [txt] if txt.strip() else []
    docs = []
    if idx[0] > 0 and txt[: idx[0]].strip():
        docs.append(txt[: idx[0]])
    for i, s in enumerate(idx):
        e = idx[i + 1] if i + 1 < len(idx) else len(txt)
        docs.append(txt[s:e])
    return [_trim_tail(d) for d in docs]


def _trim_tail(doc):
    """Drop stray punctuation artefacts after the closing root tag."""
    lines = doc.rstrip().split("\n")
    while lines:
        s = lines[-1].strip()
        if s and (s.startswith("</") or s.endswith("}") or s.endswith("]") or s.endswith(">")):
            break
        if len(s) <= 2 and not s.isalnum():
            lines.pop()
            continue
        break
    return "\n".join(lines)


TERM_RE = re.compile(r"-\s*-\s*>")


def sanitize_comments(txt):
    """Normalise annotation comments.

    The PDF wraps long comments, which can split the closing `-->` across a
    line break and leaves stray `--` inside the body (illegal in XML).  Rewrite
    every comment onto a single line with an escaped body.
    """
    out, i = [], 0
    while True:
        a = txt.find("<!--", i)
        if a < 0:
            out.append(txt[i:])
            break
        m = TERM_RE.search(txt, a + 4)
        if not m:
            out.append(txt[i:])
            break
        out.append(txt[i:a])
        body = " ".join(txt[a + 4:m.start()].split()).replace("--", "––")
        out.append("<!--" + body + "-->")
        i = m.end()
    return "".join(out)


AMP_RE = re.compile(r"&(?!#?\w+;)")


def sanitize(txt):
    t = sanitize_comments(txt)
    t = AMP_RE.sub("&amp;", t)
    return t


def strip_ns(tag):
    if isinstance(tag, str) and tag.startswith("{"):
        return tag.split("}", 1)[1]
    return tag


def parse_xml(doc_txt):
    """Return (root_element, recovered_bool) or (None, None)."""
    s = sanitize(doc_txt).strip()
    if not s or s[0] not in "<":
        return None, None
    data = s.encode("utf-8", "replace")
    for recover in (False, True):
        try:
            p = etree.XMLParser(remove_comments=False, recover=recover,
                                resolve_entities=False, huge_tree=True)
            root = etree.fromstring(data, p)
            if root is not None:
                return root, recover
        except Exception:
            continue
    return None, None


def is_json(doc_txt):
    s = doc_txt.strip()
    return s.startswith("{") or s.startswith("[")
