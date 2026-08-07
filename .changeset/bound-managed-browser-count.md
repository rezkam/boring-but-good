---
"@rezkam/browser-tools": minor
---

Bound the number of concurrent managed Chrome browsers and recover leaked ones. Starting without `--port` now reuses a browser the caller's owner token already owns instead of allocating another port, a hard cap (default 5, override with `BROWSER_TOOLS_MAX_BROWSERS` or `browser.maxBrowsers`) refuses a launch that would exceed it, and start warns on the last free slot and about browsers running longer than two hours. The live count is read from the process table rather than lifecycle files, so browsers stay visible even when their state files are gone. New `browser-tools stop --status`, `--reap`, and `--reap --dry-run` list and sweep managed browsers no lifecycle file tracks; `--prune` reaps before pruning clones, and start reaps automatically so a leak self-heals. Stop no longer deletes lifecycle files for a process that is still running, which previously turned a safety mismatch into a permanently unaddressable browser.
