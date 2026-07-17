#!/usr/bin/env python3
"""Build the error-discovery dataset from coordinator workflow journals.

One record per subagent run: the coordinator-authored dispatch prompt, the
agent's multi-turn trace (tool calls/results, thinking), the result the
coordinator received, and journal health (died / retried / aborted).

Writes into error_discovery_data/:
  records/<id>.json   full per-record content for the review UI
  samples.json        initial diverse sample (ids + meta)
  graph.json          2D PCA projection + cluster of every record
  patterns.json       seeded failure-mode taxonomy (agent-proposed, count 0)
  suggestions.json    seeded agent suggestions on known-signal records
  annotations.json    empty (the human's)
"""
import json, os, glob, math, random, re, sys, shutil
from collections import Counter

# Point this at a directory of workflow transcripts to analyze. One subdirectory
# per workflow run ("wf_*"), each holding a journal.jsonl and agent-*.jsonl files.
# Override with the COORD_WORKFLOWS_DIR env var or argv[1]. Nothing here is
# committed: the generated dataset lands in error_discovery_data/, which is
# gitignored, so raw transcripts never enter the repo.
WFDIR = (len(sys.argv) > 1 and sys.argv[1]) or os.environ.get(
    "COORD_WORKFLOWS_DIR", os.path.expanduser("~/agent-workflow-transcripts"))
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "error_discovery_data")
TOOL_RESULT_CAP = 2000      # chars kept per tool result
TEXT_CAP = 6000             # chars kept per assistant/user text block
MAX_TURNS = 400             # cap turns per record

random.seed(42)

def jread(path):
    out = []
    with open(path, errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return out

def block_text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for b in content:
            if isinstance(b, dict) and b.get("type") == "text":
                parts.append(b.get("text", ""))
            elif isinstance(b, str):
                parts.append(b)
        return "\n".join(parts)
    return ""

def campaign_of(prompt):
    p = prompt.lower()
    if "slice2b" in p or "slice 2b" in p:
        return "slice2b"
    if "slice2a" in p or "slice 2a" in p:
        return "slice2a"
    if "slice1" in p or "slice 1" in p:
        return "slice1"
    return "other"

def role_of(prompt):
    p = prompt[:600].upper()
    if "ADVERSARIAL VERIF" in p or "ADVERSARIAL, READ-ONLY" in p or "READ-ONLY, FREE-TEXT" in p:
        return "verify"
    if "ADVERSARIAL" in p and "REVIEW" in p:
        return "review"
    if "READ-ONLY" in p and ("PROBE" in p or "INVESTIGAT" in p):
        return "probe"
    if "DOC" in p and ("SYNC" in p or "REWRITE" in p or "ADR" in p):
        return "docs"
    if "FIX" in p[:80] or re.search(r"fix (two|three|the)", prompt[:400], re.I):
        return "fix"
    if "TICKET" in p or "IMPLEMENT" in p:
        return "impl"
    return "other"

def summarize_result(res):
    if res is None:
        return None
    if isinstance(res, str):
        return res
    try:
        return json.dumps(res, indent=1)
    except Exception:
        return str(res)

def main():
    # Clear every generated file (records + the derived metadata) so a smaller,
    # different, or empty transcript set cannot leave a stale index/samples/graph
    # that server.py would treat as a complete dataset or scrub.py would publish.
    # Human/seeded files (annotations, patterns, suggestions) are left untouched.
    if os.path.isdir(os.path.join(OUT, "records")):
        shutil.rmtree(os.path.join(OUT, "records"))
    for gen in ("index.json", "samples.json", "graph.json"):
        gp = os.path.join(OUT, gen)
        if os.path.exists(gp):
            os.remove(gp)
    os.makedirs(os.path.join(OUT, "records"), exist_ok=True)
    records = []
    for wfpath in sorted(glob.glob(os.path.join(WFDIR, "wf_*"))):
        wf = os.path.basename(wfpath)
        jpath = os.path.join(wfpath, "journal.jsonl")
        if not os.path.exists(jpath):
            continue
        journal = jread(jpath)
        results = {}
        started_order = []
        wfname = None
        for ev in journal:
            if not wfname:
                for k in ("workflowName", "name"):
                    if ev.get(k):
                        wfname = ev[k]
            t = ev.get("type")
            aid = ev.get("agentId") or ev.get("label")
            if t == "started" and aid:
                started_order.append(aid)
            elif t == "result" and aid:
                results[aid] = ev.get("result")
        for tpath in sorted(glob.glob(os.path.join(wfpath, "agent-*.jsonl"))):
            aid = os.path.basename(tpath)[6:-6]
            events = jread(tpath)
            if not events:
                continue
            # dispatch prompt: first user message
            prompt = ""
            for ev in events:
                if ev.get("type") == "user":
                    prompt = block_text(ev.get("message", {}).get("content"))
                    if prompt.strip():
                        break
            # walk turns
            turns = []
            model = ""
            n_tool = n_edit = n_think = 0
            tool_names = Counter()
            first_ts = last_ts = None
            api_error = None
            for ev in events:
                ts = ev.get("timestamp")
                if ts:
                    first_ts = first_ts or ts
                    last_ts = ts
                msg = ev.get("message", {})
                role = msg.get("role") or ev.get("type")
                m = msg.get("model")
                if m and m != "<synthetic>":
                    model = m
                if m == "<synthetic>":
                    api_error = block_text(msg.get("content"))[:300]
                content = msg.get("content")
                if isinstance(content, str):
                    if content.strip():
                        turns.append({"role": role, "kind": "text",
                                      "text": content[:TEXT_CAP],
                                      "trunc": len(content) > TEXT_CAP})
                    continue
                if not isinstance(content, list):
                    continue
                for b in content:
                    if not isinstance(b, dict):
                        continue
                    bt = b.get("type")
                    if bt == "text":
                        tx = b.get("text", "")
                        if tx.strip():
                            turns.append({"role": role, "kind": "text",
                                          "text": tx[:TEXT_CAP], "trunc": len(tx) > TEXT_CAP})
                    elif bt == "thinking":
                        n_think += 1
                        tx = b.get("thinking", "")
                        turns.append({"role": role, "kind": "thinking",
                                      "text": tx[:TEXT_CAP], "trunc": len(tx) > TEXT_CAP})
                    elif bt == "tool_use":
                        n_tool += 1
                        name = b.get("name", "?")
                        tool_names[name] += 1
                        if name in ("Edit", "Write", "NotebookEdit"):
                            n_edit += 1
                        try:
                            inp = json.dumps(b.get("input", {}), indent=1)
                        except Exception:
                            inp = str(b.get("input"))
                        turns.append({"role": role, "kind": "tool_use", "tool": name,
                                      "text": inp[:TOOL_RESULT_CAP],
                                      "trunc": len(inp) > TOOL_RESULT_CAP})
                    elif bt == "tool_result":
                        tx = block_text(b.get("content"))
                        turns.append({"role": role, "kind": "tool_result",
                                      "error": bool(b.get("is_error")),
                                      "text": tx[:TOOL_RESULT_CAP],
                                      "trunc": len(tx) > TOOL_RESULT_CAP})
            truncated_turns = len(turns) > MAX_TURNS
            if truncated_turns:
                turns = turns[:MAX_TURNS // 2] + [
                    {"role": "system", "kind": "text",
                     "text": f"[... {len(turns) - MAX_TURNS} middle turns omitted ...]"}
                ] + turns[-(MAX_TURNS // 2):]
            died = aid not in results
            res = summarize_result(results.get(aid))
            dur = None
            try:
                from datetime import datetime
                fmt = "%Y-%m-%dT%H:%M:%S.%fZ"
                dur = (datetime.strptime(last_ts, fmt) - datetime.strptime(first_ts, fmt)).total_seconds()
            except Exception:
                pass
            uses_schema = "StructuredOutput" in prompt or "structured output" in prompt.lower() \
                          or tool_names.get("StructuredOutput", 0) > 0
            rec = {
                "id": f"{wf}__{aid}",
                "wf": wf, "wf_name": wfname or "", "agent": aid,
                "campaign": campaign_of(prompt), "phase_role": role_of(prompt),
                "model": model, "died": died, "api_error": api_error,
                "uses_schema": uses_schema,
                "n_events": len(events), "n_turns": len(turns),
                "n_tool_calls": n_tool, "n_edits": n_edit, "n_thinking": n_think,
                "tools": dict(tool_names.most_common(12)),
                "prompt_len": len(prompt), "result_len": len(res or ""),
                "duration_s": dur,
                "_start": (started_order.index(aid) if aid in started_order else 10 ** 9),
                "prompt": prompt, "turns": turns, "result": res,
                "turns_truncated": truncated_turns,
            }
            records.append(rec)

    if not records:
        print("no records found under", WFDIR)
        return

    # mark retries: a successful agent that started AFTER a same-prompt agent
    # died in the same workflow (event order matters; an earlier success is not
    # a retry of a later death).
    by_wf = {}
    for r in records:
        by_wf.setdefault(r["wf"], []).append(r)
    for wf, rs in by_wf.items():
        dead = [d for d in rs if d["died"]]
        for r in rs:
            head = r["prompt"][:200]
            r["retry_of_dead"] = (not r["died"]) and any(
                head and d["prompt"][:200] == head and d["_start"] < r["_start"] for d in dead)
    for r in records:
        r.pop("_start", None)

    print(f"records: {len(records)}")
    print("by campaign:", Counter(r["campaign"] for r in records))
    print("by role:", Counter(r["phase_role"] for r in records))
    print("died:", sum(r["died"] for r in records),
          "retries:", sum(r["retry_of_dead"] for r in records))

    # ---- features, PCA, KMeans (pure python) ----
    def feats(r):
        return [
            math.log1p(r["prompt_len"]),
            math.log1p(r["n_events"]),
            math.log1p(r["n_tool_calls"]),
            (r["n_edits"] / r["n_tool_calls"]) if r["n_tool_calls"] else 0.0,
            math.log1p(r["result_len"]),
            1.0 if r["died"] else 0.0,
            1.0 if r["uses_schema"] else 0.0,
            {"impl": 0, "fix": 1, "verify": 2, "docs": 3, "probe": 4, "review": 5, "other": 6}[r["phase_role"]] / 6.0,
            {"slice1": 0, "slice2a": 1, "slice2b": 2, "other": 3}[r["campaign"]] / 3.0,
            math.log1p(r["duration_s"] or 0) / 10.0,
        ]
    X = [feats(r) for r in records]
    dim = len(X[0])
    # z-normalize
    means = [sum(x[j] for x in X) / len(X) for j in range(dim)]
    stds = [max(1e-9, math.sqrt(sum((x[j] - means[j]) ** 2 for x in X) / len(X))) for j in range(dim)]
    Z = [[(x[j] - means[j]) / stds[j] for j in range(dim)] for x in X]

    def kmeans(Z, k, iters=60):
        cents = random.sample(Z, k)
        assign = [0] * len(Z)
        for _ in range(iters):
            changed = False
            for i, z in enumerate(Z):
                best, bd = 0, float("inf")
                for c, cen in enumerate(cents):
                    d = sum((a - b) ** 2 for a, b in zip(z, cen))
                    if d < bd:
                        bd, best = d, c
                if assign[i] != best:
                    assign[i] = best
                    changed = True
            for c in range(k):
                pts = [Z[i] for i in range(len(Z)) if assign[i] == c]
                if pts:
                    cents[c] = [sum(p[j] for p in pts) / len(pts) for j in range(dim)]
            if not changed:
                break
        return assign, cents

    K = max(1, min(8, len(records)))
    assign, cents = kmeans(Z, K)

    # PCA via power iteration on covariance (2 components)
    def matvec(cov, v):
        return [sum(cov[i][j] * v[j] for j in range(dim)) for i in range(dim)]
    n = len(Z)
    cov = [[sum(Z[r_][i] * Z[r_][j] for r_ in range(n)) / n for j in range(dim)] for i in range(dim)]
    def power(cov, deflate=None, iters=200):
        v = [random.random() for _ in range(dim)]
        for _ in range(iters):
            if deflate:
                d = sum(a * b for a, b in zip(v, deflate))
                v = [a - d * b for a, b in zip(v, deflate)]
            w = matvec(cov, v)
            norm = math.sqrt(sum(a * a for a in w)) or 1.0
            v = [a / norm for a in w]
        return v
    p1 = power(cov)
    p2 = power(cov, deflate=p1)
    proj = [(sum(a * b for a, b in zip(z, p1)), sum(a * b for a, b in zip(z, p2))) for z in Z]

    # ---- initial sample: centroid reps + random + anomaly stratum ----
    sample_ids = []
    for c in range(K):
        members = [(i, sum((a - b) ** 2 for a, b in zip(Z[i], cents[c]))) for i in range(n) if assign[i] == c]
        members.sort(key=lambda t: t[1])
        for i, _ in members[:2]:
            sample_ids.append(records[i]["id"])
    anomalies = [r["id"] for r in records if r["died"] or r["retry_of_dead"]]
    random.shuffle(anomalies)
    for a in anomalies[:4]:
        if a not in sample_ids:
            sample_ids.append(a)
    pool = [r["id"] for r in records if r["id"] not in sample_ids]
    random.shuffle(pool)
    sample_ids.extend(pool[:6])
    sample_ids = list(dict.fromkeys(sample_ids))[:24]

    # ---- write ----
    meta_keys = ["id", "wf", "wf_name", "agent", "campaign", "phase_role", "model",
                 "died", "retry_of_dead", "api_error", "uses_schema", "n_events",
                 "n_turns", "n_tool_calls", "n_edits", "prompt_len", "result_len",
                 "duration_s"]
    # dataset-level stats for outlier flags
    stats = {}
    for k in ("n_events", "n_tool_calls", "prompt_len", "result_len"):
        vals = sorted(r[k] for r in records)
        stats[k] = {"p10": vals[int(0.1 * (n - 1))], "p90": vals[int(0.9 * (n - 1))]}

    idx = {}
    for i, r in enumerate(records):
        with open(os.path.join(OUT, "records", r["id"] + ".json"), "w") as f:
            json.dump(r, f)
        m = {k: r[k] for k in meta_keys}
        m["cluster"] = assign[i]
        m["x"], m["y"] = proj[i]
        idx[r["id"]] = m

    with open(os.path.join(OUT, "index.json"), "w") as f:
        json.dump({"records": idx, "stats": stats}, f, indent=1)
    with open(os.path.join(OUT, "samples.json"), "w") as f:
        json.dump({"sample_ids": sample_ids, "note": "initial: cluster reps + anomalies + random"}, f, indent=1)
    with open(os.path.join(OUT, "graph.json"), "w") as f:
        json.dump([{"id": r["id"], "x": proj[i][0], "y": proj[i][1],
                    "cluster": assign[i], "campaign": r["campaign"],
                    "role": r["phase_role"], "died": r["died"]}
                   for i, r in enumerate(records)], f)
    for name, default in (("annotations.json", {}), ("patterns.json", {}), ("suggestions.json", [])):
        p = os.path.join(OUT, name)
        if not os.path.exists(p):
            with open(p, "w") as f:
                json.dump(default, f)
    print(f"sample: {len(sample_ids)} records")
    print("wrote", OUT)

if __name__ == "__main__":
    main()
