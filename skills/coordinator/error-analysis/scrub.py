#!/usr/bin/env python3
"""Anonymize the raw error-discovery dataset into a publishable one.

Reads error_discovery_data/ (raw agent transcripts, gitignored) and writes
sample-data/ (committed) with every sensitive value replaced by a coherent
fake one. The real->fake map lives in scrub-map.local.json (gitignored), so no
real token appears in this script or in the published output.

Map format (scrub-map.local.json):
  {
    "literal": [["real string", "fake string"], ...],   # applied first, in order
    "word":    [["regex", "fake"], ...],                 # word-boundary, case-insensitive
    "stem":    [["realroot", "fakeroot"], ...]           # substring, case-preserving
  }

Case preservation for stems: UPPER->UPPER, Title->Title, else lower. So one
"foo"->"bar" rule rewrites foo, Foo, FOO, and every compound (fooClient,
FooService, foo-utils) consistently.

Usage: python3 scrub.py   (run from this directory)
"""
import json, os, re, glob, shutil, sys

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, "error_discovery_data")
OUT = os.path.join(HERE, "sample-data")
MAP = os.path.join(HERE, "scrub-map.local.json")

def load_map():
    if not os.path.exists(MAP):
        sys.exit(f"missing {MAP} (the local real->fake map). Nothing scrubbed.")
    m = json.load(open(MAP))
    regex = [(re.compile(r), f) for r, f in m.get("regex", [])]
    literal = m.get("literal", [])
    word = [(re.compile(r"\b" + r + r"\b", re.I), f) for r, f in m.get("word", [])]
    stem = [(re.compile(re.escape(r), re.I), f) for r, f in m.get("stem", [])]
    return regex, literal, word, stem

def case_like(sample, fake):
    if sample.isupper():
        return fake.upper()
    if sample[:1].isupper():
        return fake[:1].upper() + fake[1:]
    return fake

def scrub_text(s, regex, literal, word, stem):
    if not isinstance(s, str) or not s:
        return s
    for rx, fake in regex:
        s = rx.sub(fake, s)
    for real, fake in literal:
        s = s.replace(real, fake)
    for rx, fake in word:
        s = rx.sub(lambda mm: case_like(mm.group(0), fake), s)
    for rx, fake in stem:
        s = rx.sub(lambda mm: case_like(mm.group(0), fake), s)
    return s

def scrub_obj(o, fns):
    if isinstance(o, str):
        return scrub_text(o, *fns)
    if isinstance(o, list):
        return [scrub_obj(x, fns) for x in o]
    if isinstance(o, dict):
        return {k: scrub_obj(v, fns) for k, v in o.items()}
    return o

def block_texts(rec):
    """Reconstruct the app's per-block text list so annotations can re-anchor."""
    blocks = [rec.get("prompt", "")]
    for t in rec.get("turns", []):
        blocks.append(t.get("text", "") if isinstance(t, dict) else "")
    blocks.append(rec.get("result") or "")
    return blocks

def reanchor(items, blocks, fns):
    """Scrub quote/note text and recompute start/end against scrubbed blocks."""
    out = []
    for a in items:
        a = dict(a)
        for key in ("quote", "note"):
            if key in a:
                a[key] = scrub_text(a[key], *fns)
        bi = a.get("bi")
        q = a.get("quote", "")
        if isinstance(bi, int) and 0 <= bi < len(blocks) and q:
            pos = blocks[bi].find(q)
            if pos >= 0:
                a["start"], a["end"] = pos, pos + len(q)
            else:
                a["start"] = a["end"] = 0
        out.append(a)
    return out

def main():
    fns = load_map()
    if os.path.isdir(OUT):
        shutil.rmtree(OUT)
    os.makedirs(os.path.join(OUT, "records"), exist_ok=True)

    # Only publish records the current index references, so a stale record left
    # by an earlier, larger extraction never leaks into sample-data.
    idx_path = os.path.join(RAW, "index.json")
    allow = set(json.load(open(idx_path)).get("records", {}).keys()) if os.path.exists(idx_path) else None
    scrubbed_blocks = {}
    for f in sorted(glob.glob(os.path.join(RAW, "records", "*.json"))):
        rec = json.load(open(f))
        if allow is not None and rec.get("id") not in allow:
            continue
        rec = scrub_obj(rec, fns)
        scrubbed_blocks[rec["id"]] = block_texts(rec)
        json.dump(rec, open(os.path.join(OUT, "records", rec["id"] + ".json"), "w"))

    # index/graph/samples: plain scrub (ids are non-identifying hex/labels)
    for name in ("index.json", "graph.json", "samples.json"):
        p = os.path.join(RAW, name)
        if os.path.exists(p):
            json.dump(scrub_obj(json.load(open(p)), fns), open(os.path.join(OUT, name), "w"), indent=1)

    # annotations + suggestions: scrub + re-anchor against scrubbed record blocks
    ann = json.load(open(os.path.join(RAW, "annotations.json"))) if os.path.exists(os.path.join(RAW, "annotations.json")) else {}
    ann_out = {}
    for rid, items in ann.items():
        if rid not in scrubbed_blocks:
            continue  # drop annotations for records not in the published set
        ann_out[rid] = reanchor(items, scrubbed_blocks[rid], fns)
    json.dump(ann_out, open(os.path.join(OUT, "annotations.json"), "w"), indent=1)

    sug = json.load(open(os.path.join(RAW, "suggestions.json"))) if os.path.exists(os.path.join(RAW, "suggestions.json")) else []
    sug_out = []
    for s in sug:
        if s.get("record_id") not in scrubbed_blocks:
            continue  # drop suggestions for records not in the published set
        sug_out += reanchor([s], scrubbed_blocks[s["record_id"]], fns)
    json.dump(sug_out, open(os.path.join(OUT, "suggestions.json"), "w"), indent=1)

    pat = json.load(open(os.path.join(RAW, "patterns.json"))) if os.path.exists(os.path.join(RAW, "patterns.json")) else {}
    json.dump(scrub_obj(pat, fns), open(os.path.join(OUT, "patterns.json"), "w"), indent=1)

    n = len(glob.glob(os.path.join(OUT, "records", "*.json")))
    print(f"scrubbed {n} records -> {OUT}")

if __name__ == "__main__":
    main()
