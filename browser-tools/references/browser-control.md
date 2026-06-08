# Browser Control Reference

Use Browser Control when the task is about controlling the sandboxed Chrome itself: launch, stop, navigate, evaluate page JavaScript, take screenshots, select DOM elements, or extract generic current-page content.

## Scripts

| Script | Purpose | Example |
| --- | --- | --- |
| `scripts/config.mjs` | Create or refresh private Browser Tools config | `scripts/config.mjs profiles --refresh` |
| `scripts/start.mjs` | Launch sandboxed Chrome | `scripts/start.mjs`, `scripts/start.mjs --profile "<Chrome profile folder or local alias>"`, or `scripts/start.mjs --task <task>` |
| `scripts/stop.mjs` | Stop sandboxed Chrome | `scripts/stop.mjs --dry-run --owner-token <token>` then `scripts/stop.mjs --clean --owner-token <token>` |
| `scripts/nav.mjs` | Navigate current tab or open a new tab | `scripts/nav.mjs https://example.com --new` |
| `scripts/eval.mjs` | Run JavaScript in the active tab | `scripts/eval.mjs 'document.title'` |
| `scripts/screenshot.mjs` | Capture visible or full-page screenshot | `scripts/screenshot.mjs --full` |
| `scripts/pick.mjs` | Select DOM elements interactively | `scripts/pick.mjs "Click the price"` |
| `scripts/scrape-page.mjs` | Extract visible links from the current page | `scripts/scrape-page.mjs` |
| `scripts/extract-article.mjs` | Extract article body text from the current page | `scripts/extract-article.mjs --chars 6000` |

All executable scripts live under `scripts/`. There are no root-level compatibility wrappers.

## Profiles and config

Profile names, account labels, local aliases, and task profile preferences are private local configuration. Do not put account names, emails, account IDs, or machine-specific profile notes in this skill or its references.

Browser Tools stores private config under `~/.agents/browser-tools/config.json` by default. Set `AGENT_CONFIG_DIR` to move all agent config under another root, or `BROWSER_TOOLS_CONFIG_DIR` to move only Browser Tools config.

Out-of-box defaults:

- Config: `~/.agents/browser-tools/config.json`
- Chrome source profile directory: `~/Library/Application Support/Google/Chrome`
- Managed browser cache and copied profiles: `~/.cache/pi-browser-tools`
- Artifact directory: `/tmp`
- Chrome binary: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`

The config can override:

```json
{
  "directories": {
    "chromeSourceDir": "~/Library/Application Support/Google/Chrome",
    "cacheDir": "~/.cache/pi-browser-tools",
    "artifactDir": "/tmp"
  },
  "browser": {
    "chromeBin": "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  }
}
```

Environment variables take precedence: `BROWSER_TOOLS_CONFIG_DIR`, `BROWSER_TOOLS_CACHE_DIR`, `BROWSER_TOOLS_ARTIFACT_DIR`, `BROWSER_TOOLS_CHROME_SOURCE_DIR`, and `BROWSER_TOOLS_CHROME_BIN`.

`scripts/config.mjs profiles` creates the profile registry when missing by reading Chrome `Local State`. `scripts/config.mjs profiles --refresh` rescans and rewrites it while preserving task preferences and directory settings. `scripts/config.mjs active-profiles` shows Chrome profiles marked as last-active in `Local State`. `scripts/config.mjs task-profile set <task> --profile "<alias>"` remembers which profile to use for a specialist task. `scripts/start.mjs --profile "<alias>"` and `scripts/start.mjs --task <task>` also create the config on demand.

## Profile Sync

Profile Sync copies allow-listed auth, browser state, extension payloads, and extension state for the resolved Chrome profile folder into a per-port sandbox directory under the configured cache directory. It copies Chrome `Local State`, cookies, preferences, local storage, session storage, transport security state, trust tokens, installed extension payloads, extension cookies, extension rules, extension scripts, and local/managed/sync extension settings when those files exist.

It intentionally does not copy browser caches, history, favicons, service workers, IndexedDB, file system storage, or other large browser-generated data unrelated to matching the profile. Managed Chrome launches with Chrome sync disabled so the sandbox does not sync mutations back through the browser account. It does not use the live Chrome profile as its runtime profile.

The cached profile copy is not live. A site can be logged in in normal Chrome while the managed copy is stale and opens the same site as logged out. For account workflows and browser-authenticated providers, use `--sync` when starting the workflow or whenever auth looks wrong. If a managed browser is already running from a stale copy, stop it with `scripts/stop.mjs --clean --owner-token <token>` and then start again with the same profile plus `--sync`.

## Agent ownership

Every Managed Browser is owned by one agent token. `scripts/start.mjs` accepts `--owner-token <token>` or `BROWSER_TOOLS_OWNER_TOKEN`. When no token is provided, start generates a new token and prints it. Store it in the current agent session and pass it to follow-up commands with either `--owner-token <token>` or `BROWSER_TOOLS_OWNER_TOKEN`.

`scripts/start.mjs` also accepts `--owner-id <label>` or `--agent-id <label>` for diagnostics. The owner ID is not a secret and is not enough to connect or stop. The owner token is hashed in the managed-state file, not written in plain text.

Ownership rules:

- Starting without an explicit `--port` never reuses another listening browser. It auto-allocates the next free port and creates a new owned sandbox.
- Starting with an explicit `--port` reuses only when that browser is Browser Tools managed and the owner token matches.
- Browser Control and generic extractors refuse to connect when the owner token is missing or wrong.
- `scripts/stop.mjs` refuses to stop a live browser when the owner token is missing or wrong.
- Per-port lock directories under the configured cache directory serialize concurrent starts so two agents do not claim the same port at the same time.

## Stop safety

`stop.mjs` is intentionally conservative. It stops only a Managed Browser that `start.mjs` launched and that the caller owns. Use `scripts/stop.mjs --dry-run --owner-token <token>` to verify what would be stopped without sending a signal. The start script writes a PID file and a managed-state file under the configured cache directory, then launches Chrome with a per-run managed token and an owner-token hash.

The stop script verifies all of these before sending `SIGTERM`:

- managed-state file exists and says `managedBy: browser-tools`
- PID and port match the managed state
- process command is Chrome
- process command has the requested `--remote-debugging-port`
- managed-state user data directory is one of the Browser Tools sandbox directories
- process command uses exactly the managed-state sandbox user data directory
- process command includes the managed token from the state file
- managed-state launch args also include the debug port, sandbox user data directory, and managed token
- owner token passed to stop matches the owner-token hash in managed state

If any check fails, `stop.mjs` refuses to kill the process. This protects the main Chrome process, another agent's Managed Browser, and any browser that was manually started or only reused by `start.mjs`.

## Common workflows

### Start Chrome

```bash
scripts/start.mjs
export BROWSER_TOOLS_OWNER_TOKEN="<owner token from start output>"
scripts/config.mjs profiles
scripts/config.mjs profiles --refresh
scripts/config.mjs active-profiles
scripts/config.mjs task-profile set finance --profile "<Chrome profile folder or local alias>"
scripts/start.mjs --task finance
scripts/start.mjs --profile "<Chrome profile folder or local alias>"
scripts/start.mjs --profile "<Chrome profile folder or local alias>" --sync
scripts/start.mjs --profile "<Chrome profile folder or local alias>" --port 9223
```

For a logged-in browser task where current cookies matter, prefer:

```bash
scripts/start.mjs --profile "<Chrome profile folder or local alias>" --sync
```

If Chrome already listens on the default debug port, `start.mjs` auto-allocates the next available port and creates a separate per-port sandbox profile copy. If `--port` is explicitly provided, the script reuses that port only when it is a Browser Tools managed browser and the owner token matches.

### Background tabs and focus

Prefer background tabs for automation:

```js
const page = await browser.newPage({ background: true });
```

This avoids stealing OS focus from the user when an agent opens pages. Only call `await page.bringToFront()` when the task intentionally needs the user to see or interact with that tab. Browser Control helpers and generic extractors should keep automation in background tabs by default.

### Navigate and inspect

```bash
scripts/nav.mjs https://example.com --port <reported port> --owner-token <token>
scripts/eval.mjs 'document.title' --port <reported port> --owner-token <token>
scripts/eval.mjs 'document.querySelectorAll("a").length' --port <reported port> --owner-token <token>
scripts/screenshot.mjs --full --port <reported port> --owner-token <token>
```

### Pick DOM elements

```bash
scripts/pick.mjs "Click the price element"
```

In the browser:

- Click: select one element and finish
- Cmd/Ctrl+Click: add to multi-selection
- Enter: finish multi-selection
- Esc: cancel

## Implementation notes

`scripts/browser-control.mjs` owns port parsing, owner-token validation, per-port start locks, Chrome paths, private profile registry discovery, Profile Sync, launch and stop behavior, CDP connection, active page lookup, dedicated page lookup, safe disconnect, and artifact path creation.

Generic extractors should use `scripts/resource-helper.mjs` for shared lifecycle. Domain-specific workflows should live in specialist skills and call Browser Tools as a dependency.
