# Coordinator error analysis

A small harness for running an error-discovery review over a coordinator's own subagent runs, to find recurring
failure modes in how it dispatches, verifies, and recovers. The confirmed modes and their fixes are written up in
[taxonomy.md](taxonomy.md) and folded back into the coordinator skill (`../SKILL.md`, `../dispatch.md`,
`../recovery.md`) and the sibling `code-review/` rubric.

The review method follows the error-discovery pattern (read a dataset of agent outputs, cluster and sample diverse
records, review and annotate them in a UI, and let the agent organize free-text notes into a failure-mode taxonomy).

## Files

- `extract.py`: builds the dataset. One record per subagent run: the dispatch prompt, the multi-turn agent trace,
  the returned result, and journal health (died / retried / aborted). Point it at a directory of workflow transcripts
  via `COORD_WORKFLOWS_DIR` or argv[1]. Writes into `error_discovery_data/`.
- `scrub.py`: anonymizes the raw dataset into `sample-data/` (committed) by replacing every sensitive value with a coherent fake one, driven by a local real-to-fake map (`scrub-map.local.json`, gitignored). Run it after `extract.py`.
- `server.py`: a stdlib HTTP server for the review app. `python3 server.py [port]`. It serves `error_discovery_data/` when present, otherwise the committed `sample-data/`.
- `app.html`: the review UI: a record view (dispatch prompt, trace, result, with margin-note annotation), a cluster
  map, and a progress view with the running failure-mode taxonomy and agent-suggested annotations.
- `taxonomy.md`: the confirmed failure modes and the fixes now in the skill.

## Privacy

The raw dataset (`error_discovery_data/`) is verbatim agent transcripts and is **not** committed (gitignored).
The committed `sample-data/` is its anonymized form: `scrub.py` replaces every filesystem path, username, employer,
project name, provider/publisher name, and domain noun with a coherent fake value (case-preserving substring
substitution, so a domain noun `foo` becomes `bar` and every compound like `fooClient` becomes `barClient`; the
project name and author become fixed fake values). The real-to-fake map lives only in `scrub-map.local.json`
(gitignored), so no real token appears in this repo. The trace STRUCTURE
(roles, tool calls, journal health, failure modes) is preserved, which is what the error analysis needs. To refresh:
`python3 extract.py` (raw, local) then `python3 scrub.py` (anonymized, committed), and scan `sample-data/` for any
residual real token before publishing.
