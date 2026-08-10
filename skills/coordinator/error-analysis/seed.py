#!/usr/bin/env python3
"""Seed patterns.json + suggestions.json from the round-1/2 audit findings.

Suggestions are anchored to real text spans found in the records (bi/start/end),
status=pending; the human accepts or dismisses each in the UI.
"""
import json, os, glob

BASE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(BASE, "error_discovery_data")

MODES = {
    "silent-death-retry-inheritance": {
        "description": "Agent dies mid-run (API connection closed etc.), runtime silently retries; "
                       "the retry inherits the dead agent's uncommitted worktree edits without provenance. "
                       "Coordinator has no visibility unless it reads the journal.",
        "count": 0, "example_ids": [], "example_quotes": [],
    },
    "structured-output-schema-abort": {
        "description": "Agent completes its real work, then burns retries failing to satisfy a closed "
                       "output schema until the retry cap aborts it; the phase's work is discarded. "
                       "Recurring scar: known since 2026-06-26, recurred in slice 2B.",
        "count": 0, "example_ids": [], "example_quotes": [],
    },
    "prompt-interpolation-undefined": {
        "description": "Dispatch prompt built with an undefined template variable; agents receive "
                       "'cd undefined/...' under a header saying 'trust these, they were verified'. "
                       "No pre-dispatch lint of rendered prompts.",
        "count": 0, "example_ids": [], "example_quotes": [],
    },
    "happy-path-live-verify": {
        "description": "Live verification accepted because the run went green, although the specific "
                       "scenario the change targets never executed (noted as a caveat instead of "
                       "treated as verification failure).",
        "count": 0, "example_ids": [], "example_quotes": [],
    },
    "over-asking-on-fix-scope": {
        "description": "Coordinator escalates confirmed-defect fix-scope decisions that have an obvious "
                       "conservative default, instead of fixing under the P0-P2 bar and logging a deviation.",
        "count": 0, "example_ids": [], "example_quotes": [],
    },
    "provider-empty-response": {
        "description": "LLM provider returns empty output (quota window / flake); analyst parse fails or "
                       "run degrades. Environmental, needs classify-and-retry rather than code suspicion.",
        "count": 0, "example_ids": [], "example_quotes": [],
    },
}

SIGNATURES = [
    # (mode, needle, where) where: 'prompt' | 'turn' | 'result'
    ("silent-death-retry-inheritance", "API Error: Connection closed", "turn"),
    ("silent-death-retry-inheritance", "already implemented in source", "result"),
    ("silent-death-retry-inheritance", "presumably by a prior pass", "result"),
    ("structured-output-schema-abort", "StructuredOutput", "turn_use_died"),
    ("prompt-interpolation-undefined", "worktree: undefined", "prompt"),
    ("prompt-interpolation-undefined", "cd undefined/", "prompt"),
    ("provider-empty-response", '"raw_response":""', "turn"),
    ("provider-empty-response", "parse_failed", "turn"),
]

def main():
    suggestions = []
    sid = 1
    seen = set()  # (mode, record) one suggestion per mode per record
    for path in sorted(glob.glob(os.path.join(DATA, "records", "*.json"))):
        with open(path) as f:
            r = json.load(f)
        for mode, needle, where in SIGNATURES:
            key = (mode, r["id"])
            if key in seen:
                continue
            bi = start = None
            quote = ""
            if where == "prompt":
                idx = r["prompt"].find(needle)
                if idx >= 0:
                    bi, start = 0, idx
                    quote = r["prompt"][idx:idx + 120]
            elif where == "result" and r.get("result"):
                idx = r["result"].find(needle)
                if idx >= 0:
                    bi, start = 1 + len(r["turns"]), idx
                    quote = r["result"][idx:idx + 120]
            elif where in ("turn", "turn_use_died"):
                if where == "turn_use_died" and not r["died"]:
                    continue
                for ti, t in enumerate(r["turns"]):
                    if where == "turn_use_died" and t.get("kind") != "tool_use":
                        continue
                    if where == "turn_use_died" and t.get("tool") != "StructuredOutput":
                        continue
                    hay = t.get("text", "") if where == "turn" else (t.get("tool", "") + "\n" + t.get("text", ""))
                    idx = hay.find(needle) if where == "turn" else 0
                    if idx >= 0:
                        bi, start = 1 + ti, max(0, idx)
                        src = t.get("text", "")
                        quote = src[start:start + 120] or needle
                        break
            if bi is None:
                continue
            seen.add(key)
            suggestions.append({
                "id": sid, "record_id": r["id"], "bi": bi,
                "start": start, "end": start + max(1, len(quote)),
                "quote": quote or needle, "mode": mode,
                "note": f"seeded from the session audit: signature '{needle}'",
                "status": "pending",
            })
            sid += 1
            m = MODES[mode]
            if len(m["example_ids"]) < 6:
                m["example_ids"].append(r["id"])
                m["example_quotes"].append(quote or needle)

    with open(os.path.join(DATA, "patterns.json"), "w") as f:
        json.dump(MODES, f, indent=1)
    with open(os.path.join(DATA, "suggestions.json"), "w") as f:
        json.dump(suggestions, f, indent=1)
    from collections import Counter
    print("suggestions:", len(suggestions), Counter(s["mode"] for s in suggestions))
    print("records with suggestions:", len({s['record_id'] for s in suggestions}))

if __name__ == "__main__":
    main()
