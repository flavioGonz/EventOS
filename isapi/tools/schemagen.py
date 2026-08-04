#!/usr/bin/env python3
"""Turn an annotated ISAPI XML sample tree into an OpenAPI 3.1 JSON Schema."""
import re
from lxml import etree
import annot
from xmlblocks import strip_ns

# Attributes that carry structural metadata rather than data
META_ATTRS = {"xmlns", "version"}
NUMERIC = {"integer", "number"}


def _comment_of(el):
    """First annotation comment that belongs to this element."""
    for node in el:
        if isinstance(node, etree._Comment):
            return node
        break
    # comment may sit after leading text but before first child
    for node in el:
        if isinstance(node, etree._Comment):
            return node
    return None


def _sample_value(el, comment):
    if comment is not None and comment.tail:
        v = comment.tail.strip()
        if v:
            return v
    if el.text:
        v = el.text.strip()
        if v:
            return v
    return None


def _num(v):
    v = v.strip()
    try:
        if re.fullmatch(r"[+-]?\d+", v):
            return int(v)
        return float(v)
    except ValueError:
        return None


def _apply_scalar(sch, a, sample, fields=None, name=None):
    t = annot.json_type(a)
    sch["type"] = t
    if a.get("type") == "time":
        sch["format"] = "date-time"
        sch.setdefault("x-hik-type", "time")
    if a.get("range"):
        lo, hi = a["range"]
        if t in NUMERIC:
            n = _num(lo)
            if n is not None:
                sch["minimum"] = n
            n = _num(hi)
            if n is not None:
                sch["maximum"] = n
        elif t == "string":
            n = _num(lo)
            if n is not None:
                sch["minLength"] = int(n)
            n = _num(hi)
            if n is not None:
                sch["maxLength"] = int(n)
    if a.get("unit"):
        sch["x-hik-unit"] = a["unit"]
    if a.get("step"):
        sch["x-hik-step"] = a["step"]
    if a.get("dep"):
        sch["x-hik-dep"] = a["dep"]
    if a.get("default") is not None:
        sch["default"] = a["default"]
    if sample is not None:
        sch["examples"] = [_coerce(sample, t)]
    return sch


def _coerce(v, t):
    if t == "integer":
        n = _num(v)
        return int(n) if isinstance(n, (int, float)) else v
    if t == "number":
        n = _num(v)
        return n if n is not None else v
    if t == "boolean":
        if v.lower() in ("true", "false"):
            return v.lower() == "true"
    return v


ENUM_SPLIT = re.compile(r"\s*,\s*")
PAREN_CJK = re.compile(r"\([^)]*[一-鿿][^)]*\)")


def _enum_from_attr(el):
    """`opt="a,b,c"` on an element enumerates its allowed values."""
    raw = el.get("opt")
    if not raw:
        return None, None
    cleaned = PAREN_CJK.sub("", raw)
    vals = [v.strip() for v in ENUM_SPLIT.split(cleaned) if v.strip()]
    return (vals or None), raw


def build(el, fields=None, path=""):
    """Recursively build a JSON Schema for one annotated XML element."""
    name = strip_ns(el.tag)
    comment = _comment_of(el)
    a = annot.parse(comment.text or "") if comment is not None else {
        "access": "rw", "presence": None, "type": None, "subType": None,
        "range": None, "unit": None, "step": None, "dep": None, "attrs": {},
        "default": None, "desc": None, "raw": ""}
    kids = [c for c in el if not isinstance(c, etree._Comment) and isinstance(c.tag, str)]

    sch = {}
    if a.get("desc"):
        sch["description"] = a["desc"]
    if a.get("access") == "ro":
        sch["readOnly"] = True
    elif a.get("access") == "wo":
        sch["writeOnly"] = True

    # ---- attributes -------------------------------------------------
    attr_props = {}
    attr_required = []
    for an, av in a.get("attrs", {}).items():
        asch = {"type": annot.json_type(av), "xml": {"attribute": True}}
        if av.get("desc"):
            asch["description"] = av["desc"]
        if av.get("range"):
            _apply_scalar(asch, av, None)
            asch["xml"] = {"attribute": True}
        attr_props["@" + an] = asch
        if av.get("presence") == "req":
            attr_required.append("@" + an)
    for an, av in el.attrib.items():
        an = strip_ns(an)
        if an in META_ATTRS or ("@" + an) in attr_props:
            continue
        if an == "opt":
            continue
        attr_props.setdefault("@" + an, {"type": "string", "xml": {"attribute": True},
                                         "examples": [av]})

    if kids:
        groups = {}
        for c in kids:
            groups.setdefault(strip_ns(c.tag), []).append(c)
        is_array = a.get("type") == "array" or (
            len(groups) == 1 and len(next(iter(groups.values()))) > 1)
        if is_array and len(groups) == 1:
            gname, glist = next(iter(groups.items()))
            item = build(glist[0], fields, f"{path}/{name}")
            item.setdefault("xml", {})["name"] = gname
            sch["type"] = "array"
            sch["items"] = item
            sch["xml"] = {"name": name, "wrapped": True}
            if attr_props:
                sch["x-hik-attributes"] = attr_props
            return sch
        props, required = {}, []
        for gname, glist in groups.items():
            child = build(glist[0], fields, f"{path}/{name}")
            if len(glist) > 1:
                child = {"type": "array", "items": child,
                         "xml": {"name": gname, "wrapped": False}}
            props[gname] = child
            csch = glist[0]
            ccom = _comment_of(csch)
            ca = annot.parse(ccom.text or "") if ccom is not None else {}
            if ca.get("presence") == "req":
                required.append(gname)
        props.update(attr_props)
        required += attr_required
        sch["type"] = "object"
        sch["properties"] = props
        if required:
            sch["required"] = required
        sch["xml"] = {"name": name}
        if a.get("type") and a["type"] not in ("object", "array"):
            sch["x-hik-type"] = a["type"]
        return sch

    # ---- leaf -------------------------------------------------------
    sample = _sample_value(el, comment)
    _apply_scalar(sch, a, sample)
    enum_vals, enum_raw = _enum_from_attr(el)
    if enum_vals:
        sch["enum"] = enum_vals
        sch["x-hik-enum-source"] = "sample-attribute"
    elif a.get("type") == "enum" and fields:
        fv = fields.get(name)
        if fv:
            sch["enum"] = [v["value"] for v in fv]
            sch["x-hik-enum-source"] = "field-dictionary"
            desc = "; ".join(f"{v['value']} = {v['desc']}" for v in fv if v.get("desc"))
            if desc:
                sch["description"] = (sch.get("description", "") + " | " + desc).strip(" |")
    if enum_raw and not enum_vals:
        sch["x-hik-enum-raw"] = enum_raw
    if a.get("type") == "enum":
        sch.setdefault("x-hik-type", "enum")
    if attr_props:
        sch = {"type": "object", "properties": {**attr_props, "#text": dict(sch)},
               "xml": {"name": name}}
    else:
        sch["xml"] = {"name": name}
    return sch


def root_schema(root, fields=None):
    s = build(root, fields)
    s["x-hik-root"] = strip_ns(root.tag)
    ns = root.tag.split("}")[0][1:] if isinstance(root.tag, str) and root.tag.startswith("{") else None
    if ns:
        s["x-hik-namespace"] = ns
        m = re.search(r"/ver(\d+)/", ns)
        if m:
            v = m.group(1)
            s["x-hik-schema-version"] = f"{v[0]}.{v[1:]}" if len(v) > 1 else v
    if root.get("version"):
        s["x-hik-protocol-version"] = root.get("version")
    return s
