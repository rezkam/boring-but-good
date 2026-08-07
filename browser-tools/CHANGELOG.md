# @rezkam/browser-tools

## 1.0.0

### Major Changes

- 6a7d46c: Require an owner for every managed browser, and make an unowned one reclaimable. `startChrome` now refuses to launch without an `ownerId`: an unowned browser cannot be adopted or stopped by anything, because its owner token exists only in the caller that started it, so once that process exits the browser holds a slot, its clone directory, and its memory with nothing able to reclaim it. This is the breaking part, since library callers that omitted `ownerId` now fail fast instead of leaking. A command-line `browser-tools start` stamps `cli` when neither `--owner-id` nor `BROWSER_TOOLS_OWNER_ID` is set, so a shell launch is never anonymous, and each lifecycle record now stores `launchedByPid` so a browser that outlives its launcher stays attributable.

  Cleanup no longer has a blind spot. A browser that nothing owns counts as reclaimable even when its lifecycle files are perfectly consistent, so `stop --reap`, `stop --prune`, and the automatic pre-launch reap can now clear it. `stop --port <n>` may also stop an unowned browser without a token and reports `(reclaimed: nothing owned it)` when it does. Owned browsers still require their matching token, and adopting or connecting never accepts an unowned browser, so this cannot be used to hijack one.

### Minor Changes

- 9858593: Bound the number of concurrent managed Chrome browsers and recover leaked ones. Starting without `--port` now reuses a browser the caller's owner token already owns instead of allocating another port, a hard cap (default 5, override with `BROWSER_TOOLS_MAX_BROWSERS` or `browser.maxBrowsers`) refuses a launch that would exceed it, and start warns on the last free slot and about browsers running longer than two hours. The live count is read from the process table rather than lifecycle files, so browsers stay visible even when their state files are gone. New `browser-tools stop --status`, `--reap`, and `--reap --dry-run` list and sweep managed browsers no lifecycle file tracks; `--prune` reaps before pruning clones, and start reaps automatically so a leak self-heals. Stop no longer deletes lifecycle files for a process that is still running, which previously turned a safety mismatch into a permanently unaddressable browser.

## 0.3.0

### Minor Changes

- f7f8067: Capture owner-protected filtered HTTP HAR and raw CDP events from active-tab interactions, extract private chronological network recipes for agent analysis, and send guarded direct CDP calls. Preserve exact debugging evidence by default with optional redaction, and use raw CDP for WebSocket protocol traffic.
- e9e9c3c: Record owner-protected active-tab GIFs around multi-step browser interactions, require pre-action and post-action frames and meaningful output filenames, then probe recordings and generate owner-only sampled contact sheets for visual review.

## 0.2.1

### Patch Changes

- 8ea5041: Verify automated npm publishing after the initial package release.

## 0.2.0

### Minor Changes

- 85e2099: Publish Browser Tools as an installable npm package, `@rezkam/browser-tools`, with a `browser-tools` CLI (`start`, `status`, `stop`, `nav`, `eval`, `screenshot`, `pick`, `config`, `scrape-page`, `extract-article`) and a programmatic export of the browser control module, so external consumers can depend on a pinned version instead of a cloned script path. The skill's existing `scripts/*.mjs` interface for agents working directly in this repo is unchanged.
