#!/usr/bin/env python3
"""Extract the shared reference tables (error codes, field dictionary) from the xlsx."""
import json, os, sys, collections, openpyxl

def field_dictionary(path):
    ws = openpyxl.load_workbook(path, read_only=True)["Sheet1"]
    out = collections.defaultdict(list)
    for r in list(ws.iter_rows(values_only=True))[1:]:
        desc, field, dtype, attrtype, value, valdesc, _ = (list(r) + [None] * 7)[:7]
        if not field:
            continue
        out[str(field).strip()].append({
            "value": str(value).strip() if value is not None else None,
            "desc": str(valdesc).strip() if valdesc else None,
            "type": str(dtype).strip() if dtype else None,
            "subType": str(attrtype).strip() if attrtype else None,
            "field_desc": str(desc).strip() if desc else None})
    return out

def error_codes(path):
    ws = openpyxl.load_workbook(path, read_only=True)["Sheet1"]
    out = []
    for r in list(ws.iter_rows(values_only=True))[1:]:
        sc, ss, sub, ec, de = (list(r) + [None] * 5)[:5]
        if sc is None and sub is None:
            continue
        out.append({"statusCode": str(sc).strip() if sc is not None else None,
                    "statusString": str(ss).strip() if ss else None,
                    "subStatusCode": str(sub).strip() if sub else None,
                    "errorCode": str(ec).strip() if ec else None,
                    "description": str(de).strip() if de else None})
    return out

if __name__ == "__main__":
    src, build, common = sys.argv[1], sys.argv[2], sys.argv[3]
    os.makedirs(build, exist_ok=True); os.makedirs(common, exist_ok=True)
    fd = field_dictionary(os.path.join(src, "Field Dictionary.xlsx"))
    ec = error_codes(os.path.join(src, "ErrorCode.xlsx"))
    for d, name in ((fd, "field-dictionary.json"), (ec, "error-codes.json")):
        for target in (build, common):
            json.dump(d, open(os.path.join(target, name), "w", encoding="utf-8"),
                      ensure_ascii=False, indent=0)
    print(f"fields={len(fd)} enum-values={sum(len(v) for v in fd.values())} error-codes={len(ec)}")
