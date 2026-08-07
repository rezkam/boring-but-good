---
"@rezkam/browser-tools": major
---

Require an owner for every managed browser, and make an unowned one reclaimable. `startChrome` now refuses to launch without an `ownerId`: an unowned browser cannot be adopted or stopped by anything, because its owner token exists only in the caller that started it, so once that process exits the browser holds a slot, its clone directory, and its memory with nothing able to reclaim it. This is the breaking part, since library callers that omitted `ownerId` now fail fast instead of leaking. A command-line `browser-tools start` stamps `cli` when neither `--owner-id` nor `BROWSER_TOOLS_OWNER_ID` is set, so a shell launch is never anonymous, and each lifecycle record now stores `launchedByPid` so a browser that outlives its launcher stays attributable.

Cleanup no longer has a blind spot. A browser that nothing owns counts as reclaimable even when its lifecycle files are perfectly consistent, so `stop --reap`, `stop --prune`, and the automatic pre-launch reap can now clear it. `stop --port <n>` may also stop an unowned browser without a token and reports `(reclaimed: nothing owned it)` when it does. Owned browsers still require their matching token, and adopting or connecting never accepts an unowned browser, so this cannot be used to hijack one.
