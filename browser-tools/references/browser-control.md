# Browser Control Reference

Use Browser Control when the task is about controlling the sandboxed Chrome itself: launch, stop, navigate, evaluate page JavaScript, take screenshots, select DOM elements, or extract generic current-page content.

## Commands

Requires the `@rezkam/browser-tools` npm package (`npm install -g @rezkam/browser-tools`, or run each command via `npx @rezkam/browser-tools <subcommand>`). Every subcommand dispatches to the matching script under `scripts/` unchanged. GIF recording and review also require ffmpeg and its ffprobe tool (`brew install ffmpeg`).

| Command | Purpose | Example |
| --- | --- | --- |
| `browser-tools config` | Create or refresh private Browser Tools config | `browser-tools config profiles --refresh` |
| `browser-tools start` | Launch sandboxed Chrome | `browser-tools start`, `browser-tools start --profile "<Chrome profile folder or local alias>"`, `browser-tools start --task <task>`, or `browser-tools start --headless` |
| `browser-tools status` | Report whether a managed Chrome instance is running for a port | `browser-tools status --port 9223 --json` |
| `browser-tools stop` | Stop sandboxed Chrome, or sweep leftovers | `browser-tools stop --dry-run` then `browser-tools stop --clean`; `browser-tools stop --status`, `--reap`, `--prune` |
| `browser-tools nav` | Navigate current tab or open a new tab | `browser-tools nav https://example.com --new` |
| `browser-tools eval` | Run JavaScript in the active tab | `browser-tools eval 'document.title'` |
| `browser-tools screenshot` | Capture visible or full-page screenshot | `browser-tools screenshot --full` |
| `browser-tools record-gif` | Start, inspect, or stop active-tab GIF recording | `browser-tools record-gif start --output ./login_process.gif` |
| `browser-tools review-gif` | Probe a GIF and render a sampled contact sheet | `browser-tools review-gif ./login_process.gif` |
| `browser-tools record-har` | Record filtered active-tab HTTP traffic as HAR 1.2 | `browser-tools record-har start --output ./checkout_api_network.har --preset api` |
| `browser-tools extract-har` | Extract chronological agent-readable network recipe | `browser-tools extract-har ./checkout_api_network.har` |
| `browser-tools record-cdp` | Record selected raw active-tab CDP events as JSONL | `browser-tools record-cdp start --output ./checkout_network_events.jsonl --domain Network` |
| `browser-tools cdp` | Send one owner-protected active-tab CDP method | `browser-tools cdp call Runtime.evaluate --params '{"expression":"document.title"}'` |
| `browser-tools pick` | Select DOM elements interactively | `browser-tools pick "Click the price"` |
| `browser-tools scrape-page` | Extract article-like visible links from the current page | `browser-tools scrape-page` |
| `browser-tools extract-article` | Extract article body text from the current page | `browser-tools extract-article --chars 6000` |

There are no root-level compatibility wrappers; the CLI is the supported entry point. Examples that connect to a running managed browser assume `BROWSER_TOOLS_OWNER_TOKEN` is set.

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
    "chromeBin": "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "maxBrowsers": 5
  }
}
```

Environment variables take precedence: `BROWSER_TOOLS_CONFIG_DIR`, `BROWSER_TOOLS_CACHE_DIR`, `BROWSER_TOOLS_ARTIFACT_DIR`, `BROWSER_TOOLS_CHROME_SOURCE_DIR`, `BROWSER_TOOLS_CHROME_BIN`, and `BROWSER_TOOLS_MAX_BROWSERS`.

### Legacy profile config compatibility

Earlier Browser Tools code imported Chrome profile config helpers from `scripts/browser-control.mjs`. These names remain compatibility aliases to the current Browser Tools config layer: `browserToolsProfilesConfigFile`, `buildChromeProfilesConfig`, `readChromeProfilesConfig`, `writeChromeProfilesConfig`, and `ensureChromeProfilesConfig`. The legacy path constants `CHROME_BIN`, `CHROME_SRC`, `CACHE_DIR`, `PROFILE_DST`, `FRESH_PROFILE_DIR`, and `PROFILE_SYNC_STATE_FILE` also remain exported with their original default paths.

The compatibility constants do not reflect environment variables or private config overrides. New code should use `browserToolsRuntimeConfig`, `browserToolsConfigFile`, `browserToolsChromeSourceDir`, `browserToolsCacheDir`, and the per-port path helpers so runtime overrides are honored.

`browser-tools config profiles` creates the profile registry when missing by reading Chrome `Local State`. `browser-tools config profiles --refresh` rescans and rewrites it while preserving task preferences and directory settings. `browser-tools config active-profiles` shows Chrome profiles marked as last-active in `Local State`. `browser-tools config task-profile set <task> --profile "<alias>"` remembers which profile to use for a specialist task. `browser-tools start --profile "<alias>"` and `browser-tools start --task <task>` also create the config on demand.

## Profile Sync

Profile Sync copies allow-listed auth, browser state, extension payloads, and extension state for the resolved Chrome profile folder into a per-port sandbox directory under the configured cache directory. It copies Chrome `Local State`, cookies, account web data, web data (autofill plus the account OAuth refresh token in `token_service`), preferences, local storage, session storage, transport security state, trust tokens, installed extension payloads, extension cookies, extension rules, extension scripts, and local/managed/sync extension settings when those files exist.

It intentionally does not copy browser caches, history, favicons, service workers, IndexedDB, file system storage, or other large browser-generated data unrelated to matching the profile. Managed Chrome launches with Chrome sync disabled so the sandbox does not sync mutations back through the browser account. It does not use the live Chrome profile as its runtime profile.

### Google identity is excluded by default

A clone is a second live browser. If it carries the source profile's Google session, Google's session-theft protection can revoke the shared rotating session token and log the source Chrome out of Google, even when the clone never opens a Google page (background account reconcile is enough). So by default Profile Sync strips the Google identity from the copied profile: it deletes cookies for the Google ecosystem (google.com and all its account services such as Gmail, Drive, Docs, Photos, Play, Cloud, and Gemini, plus YouTube and related Google-owned domains and country search domains) from the copied Cookies databases, and clears the Google OAuth refresh token from the copied `Web Data` (`token_service`). The domain list lives in `GOOGLE_IDENTITY_DOMAINS` and is easy to extend for new Google services. Only plain-text columns are touched, no cookie values are decrypted, and all other site logins (for example WSJ, Bloomberg, X, Instagram) are preserved. Non-Google workflows (news, X, Instagram, most finance) are unaffected and no longer risk the source Google session.

Pass `--include-google` to keep the Google session in the clone. This is required for Google-backed workflows (for example ai-chat's Gemini provider, or any task that must be signed in to a Google property), and it re-introduces the source-logout risk, so use it only when the workflow genuinely needs Google. Switching the flag forces a fresh sync, because a cached copy made with the other setting is not reused.

The cached profile copy is not live. A site can be logged in in normal Chrome while the managed copy is stale and opens the same site as logged out. For account workflows and browser-authenticated providers, use `--sync` when starting the workflow or whenever auth looks wrong. If a managed browser is already running from a stale copy, set `BROWSER_TOOLS_OWNER_TOKEN`, stop it with `browser-tools stop --clean`, and then start again with the same profile plus `--sync`.

### Cleanup

Each clone lives in a per-port sandbox directory (about 400 MB per profile), and each running browser costs roughly 800 MB of memory across its process tree. `browser-tools stop --clean` removes the clone data directory and its per-port sync-state file for the stopped browser. `browser-tools stop --prune` first reaps untracked browsers, then sweeps every cached clone that is not currently in use by a running managed Chrome, removing each stale clone directory along with its sync-state and lifecycle files; add `--dry-run` to preview. Prune keeps any clone still owned by a live process and never touches non-clone cache entries such as ai-chat data.

## Concurrency limits

A managed browser is expensive, and nothing stops an agent session from calling `start` in a loop. Three guardrails bound that:

- **A hard cap of 5 concurrent managed browsers.** A start that would exceed it fails with the list of occupied ports and the commands that free one. Override deliberately with `BROWSER_TOOLS_MAX_BROWSERS=<n>` or `browser.maxBrowsers` in the config file; a configured `maxBrowsers` survives `browser-tools config profiles --refresh`, in both the nested `browser.maxBrowsers` and legacy top-level forms.
- **A warning on the last free slot**, printed before the launch, so hitting the cap is never a surprise.
- **A warning about leftovers.** Any managed browser running longer than two hours is reported at start time as a likely leftover from a finished session.

The count comes from scanning the process table for browsers carrying the managed token and a user-data-dir inside the cache directory, not from the lifecycle files. The `--user-data-dir` value is read up to the next argument rather than the next space, so a cache directory containing spaces is handled correctly, and the cache directory is normalised so a configured trailing slash still matches. Clone directories are matched on path segments, so a sibling such as `/opt/cache-other` is never mistaken for `/opt/cache`. Files can be deleted while a browser keeps running; processes cannot. Helper processes (renderers, GPU, utility) are excluded, so the count is browsers, not processes.

The cap holds under concurrency. Slot reservation and the spawn happen together under a single cache-wide `launch.lock`, because the per-port locks cannot bound a total: two starts racing for different ports never contend, so both could pass the same check and both launch. The reservation count also includes a browser whose state file exists with a live PID but which has not yet appeared in the process table, closing the gap right after a spawn. A start that cannot take the launch lock within 30 seconds fails rather than proceeding uncounted.

### Reaping untracked browsers

A managed browser whose lifecycle files no longer describe it is an **orphan**. That includes a half-written pair where only one of the pid and state files survives, and state that contradicts the running process on port, clone directory, or managed token. The orphan test deliberately matches what `stop` verifies, so the two can never disagree and strand a browser between them.

An orphan: `browser-tools stop --port <n>` cannot see it, and it holds both a memory slot and its clone directory indefinitely.

- `browser-tools stop --status` lists every running managed browser with its port, PID, and age, plus the cap and any warnings.
- `browser-tools stop --reap` kills the orphans. Add `--dry-run` to list them first. It exits non-zero if a browser could not be reaped, so a script freeing a slot can tell the cleanup did not work.
- `browser-tools stop --prune --dry-run` previews the reap and the clone removals it enables, rather than reporting those clones as still in use.
- `browser-tools start` reaps orphans automatically before counting against the cap, then prunes their clone dirs, so a leak self-heals on the next start.

Reaping only ever targets processes carrying the Browser Tools managed token *and* a user-data-dir inside the cache directory, so the main Chrome and any unrelated browser are never candidates. Every PID is re-verified immediately before each signal, and the check compares the full scanned identity (port, clone directory, and the per-launch managed token) rather than only that the PID is *some* managed Chrome. A PID recycled between the scan and the kill, even by another managed browser, is therefore skipped rather than signalled. A port held by a concurrent start's lock is skipped, because that browser exists before its state file does.

## Agent ownership

Every Managed Browser is owned by one agent token. For a user-supplied token, export `BROWSER_TOOLS_OWNER_TOKEN` before running `browser-tools start` and reuse that environment for follow-up commands. When no token is provided, start generates a new token and prints it. Store it in the current agent session with `export BROWSER_TOOLS_OWNER_TOKEN="<owner token from start output>"`. Use `--owner-token` only when the environment variable is impractical because command-line arguments can be visible to other local users through process listings.

`browser-tools start` also accepts `--owner-id <label>` or `--agent-id <label>` for diagnostics. The owner ID is not a secret and is not enough to connect or stop. The owner token is hashed in the managed-state file, not written in plain text.

Ownership rules:

- Starting without an explicit `--port` reuses a running browser that the caller's owner token already owns, on whatever port it landed on, **provided its launch configuration matches the request**. Export `BROWSER_TOOLS_OWNER_TOKEN` after the first start and repeated starts in that session return the same browser instead of accumulating new ones.
- Reuse requires the same profile, the same headless mode, and the same Google mode, and is skipped entirely when `--sync` is passed. Adopting a browser built from a different profile would run the automation against the wrong account, headless is fixed at launch, and `--sync` explicitly asks for freshly copied credentials. A mismatch on an explicit `--port` reports which setting differs rather than an ownership error.
- Starting without an explicit `--port` and without an owner token cannot prove ownership of anything, so it auto-allocates the next free port and creates a new owned sandbox, subject to the concurrency cap.
- Starting with an explicit `--port` reuses only when that browser is Browser Tools managed and the owner token matches.
- Reuse never crosses Google modes: a default (stripped) start will not adopt a `--include-google` browser, or the reverse.
- Browser Control, GIF recorders, and generic extractors refuse to connect when the owner token is missing or wrong.
- `browser-tools stop` refuses to stop a live browser when the owner token is missing or wrong.
- Per-port lock directories under the configured cache directory serialize concurrent starts so two agents do not claim the same port at the same time.

## Stop safety

`browser-tools stop` is intentionally conservative. It stops only a Managed Browser that `browser-tools start` launched and that the caller owns. With `BROWSER_TOOLS_OWNER_TOKEN` set, use `browser-tools stop --dry-run` to verify what would be stopped without sending a signal. The start command writes a PID file and a managed-state file under the configured cache directory, then launches Chrome with a per-run managed token and an owner-token hash.

The stop command verifies all of these before sending `SIGTERM`:

- managed-state file exists and says `managedBy: browser-tools`
- PID and port match the managed state
- process command is Chrome
- process command has the requested `--remote-debugging-port`
- managed-state user data directory is one of the Browser Tools sandbox directories
- process command uses exactly the managed-state sandbox user data directory
- process command includes the managed token from the state file
- managed-state launch args also include the debug port, sandbox user data directory, and managed token
- owner token passed to stop matches the owner-token hash in managed state

If any check fails, `browser-tools stop` refuses to kill the process. This protects the main Chrome process, another agent's Managed Browser, and any browser that was manually started or only reused by `browser-tools start`.

## Common workflows

### Start Chrome

```bash
browser-tools start
export BROWSER_TOOLS_OWNER_TOKEN="<owner token from start output>"
browser-tools config profiles
browser-tools config profiles --refresh
browser-tools config active-profiles
browser-tools config task-profile set finance --profile "<Chrome profile folder or local alias>"
browser-tools start --task finance
browser-tools start --profile "<Chrome profile folder or local alias>"
browser-tools start --profile "<Chrome profile folder or local alias>" --sync
browser-tools start --profile "<Chrome profile folder or local alias>" --port 9223
browser-tools start --headless
```

### Check status

```bash
browser-tools status
browser-tools status --port 9223
browser-tools status --json
```

`browser-tools status` reads the same managed-state file `browser-tools start` writes and `browser-tools stop` verifies; it never launches or connects to Chrome. It reports whether a managed Chrome instance is verified running for the port, along with PID, profile name, headless/includeGoogle mode, and owner ID (never the owner token).

### Headless mode

Add `--headless` to `browser-tools start` to run the managed Chrome without opening a visible window. Use it for automation that does not need the user to watch or interact: navigation, evaluation, scraping, extraction, and screenshots all work the same over CDP. It launches Chrome's new headless mode (`--headless=new`), which runs the full browser, so the copied profile, cookies, and extensions load exactly as they do in a windowed launch. Old `--headless` is a separate lightweight engine that ignores extensions and is never used.

A headless launch would otherwise advertise a `HeadlessChrome` User-Agent. When the copied profile is signed in to Google, that headless fingerprint trips Google's session-theft protection and logs the source Chrome profile out, while a windowed launch (normal Chrome UA) does not. So a headless launch overrides the User-Agent, browser-wide, to the normal reduced Chrome UA for the installed version, making a headless clone match a windowed one. The override carries no machine-specific data.

```bash
browser-tools start --headless
browser-tools start --profile "<Chrome profile folder or local alias>" --headless --sync
```

Headless is a launch-time choice recorded in the managed state. To switch a running browser between windowed and headless, stop it (`browser-tools stop --clean` with the owner token) and start again with or without `--headless`. Pick `--headless` when no user interaction is needed and a windowed launch only when the task intentionally needs the user to see or drive the page.

For a logged-in browser task where current cookies matter, prefer:

```bash
browser-tools start --profile "<Chrome profile folder or local alias>" --sync
```

If Chrome already listens on the default debug port, `browser-tools start` auto-allocates the next available port and creates a separate per-port sandbox profile copy. If `--port` is explicitly provided, the command reuses that port only when it is a Browser Tools managed browser and the owner token matches.

### Background tabs and focus

Prefer background tabs for automation:

```js
const page = await browser.newPage({ background: true });
```

This avoids stealing OS focus from the user when an agent opens pages. Only call `await page.bringToFront()` when the task intentionally needs the user to see or interact with that tab. Browser Control helpers and generic extractors should keep automation in background tabs by default.

### Navigate and inspect

```bash
browser-tools nav https://example.com --port <reported port>
browser-tools eval 'document.title' --port <reported port>
browser-tools eval 'document.querySelectorAll("a").length' --port <reported port>
browser-tools screenshot --full --port <reported port>
```

### Record a multi-step interaction as GIF

Use a GIF when the user needs visual inspection or playback of a multi-step browser flow. The recorder captures the active tab selected when recording starts.

```bash
browser-tools record-gif start --output "$PWD/login_process.gif" --port <reported port>
# Perform navigation, clicks, typing, or other browser actions.
browser-tools record-gif status --port <reported port> --json
browser-tools record-gif stop --port <reported port>
```

`start` does not return until it has captured the default 1000 ms pre-action period. Begin actions only after it returns. `stop` captures another 1000 ms post-action period before it writes the final path to stdout. These extra frames keep the first and final states readable and make playback smooth. Both periods stay enabled; optional `--pre-roll-ms` and `--post-roll-ms` values can adjust them from 100 to 10000 ms.

Always pass `--output` with a meaningful, action-specific `.gif` filename, such as `login_process.gif`, `checkout_validation.gif`, or `settings_theme_change.gif`. Generic names such as `recording.gif`, `capture.gif`, and `output.gif` are rejected. Relative paths resolve from the command's working directory. Existing files are preserved unless `--overwrite` is set.

Useful recording options:

- `--fps <1-30>`, default 10
- `--colors <2-256>`, default 128
- `--scale <0.1-2>`, default 1
- `--max-duration <1-3600>`, default 120 seconds
- `--pre-roll-ms <100-10000>`, default 1000
- `--post-roll-ms <100-10000>`, default 1000

Stop recording before stopping Chrome. Recording runs in a detached owner-token-protected worker and is bounded by `--max-duration`, so an abandoned command does not record forever. `status` reports whether that worker is starting, recording, in post-action capture, completed, or failed. A recording stays tied to its original tab. If an interaction opens and moves to another tab, stop the current GIF and start another recording with a name that describes the new tab's flow.

### Review recorded GIF frames

After every multi-step visual recording, probe the media and build a contact sheet:

```bash
browser-tools review-gif ./login_process.gif
```

The command uses ffprobe to read the frame count, duration, frame rate, and dimensions. It then uses ffmpeg to sample frames across the GIF and tile them into a PNG. Defaults are 2 sampled frames per second, 480-pixel frame width, and a 4 by 4 sheet. For GIFs that would exceed the sheet's 16 cells, it lowers the sampling rate so the contact sheet still represents the full duration.

Default outputs are derived from the meaningful GIF name:

```text
./.gif-review/login_process-contact-sheet.png
./.gif-review/login_process-review.json
```

The review directory uses owner-only mode `0700`. The contact sheet and JSON metadata use owner-only mode `0600`, matching the source recording's privacy boundary.

Read the contact sheet image and verify all three parts of the visual story:

1. Initial state before the first action
2. Important intermediate action states
3. Final state after the last action

If the beginning or ending is not readable, record again with longer `--pre-roll-ms` or `--post-roll-ms`. If an important intermediate action is missing, increase review `--fps`, increase `--columns` or `--rows`, or record the interaction at a higher `record-gif --fps` value.

Useful review options:

- `--out-dir <path>`
- `--fps <0.1-30>`, maximum sampling rate, default 2
- `--width <64-1920>`, default 480
- `--columns <1-10>`, default 4
- `--rows <1-10>`, default 4
- `--json`, prints the same report stored in the review JSON

For direct debugging, these commands show the underlying short-GIF process:

```bash
mkdir -p .gif-review
ffprobe -v error -count_frames \
  -show_entries stream=nb_read_frames,duration,r_frame_rate \
  -of default=nw=1 login_process.gif
ffmpeg -v error -i login_process.gif \
  -vf "fps=2,scale=480:-1,tile=4x4" \
  -frames:v 1 .gif-review/login_process-contact-sheet.png
ls -lh .gif-review/login_process-contact-sheet.png
```

Prefer `browser-tools review-gif` for normal use because it validates inputs, chooses a sampling rate that fits the sheet, uses meaningful output names, and writes machine-readable metadata.

### Record filtered HTTP traffic as HAR

Use HAR capture to observe the network behavior caused by a browser interaction:

```bash
browser-tools record-har start \
  --output "$PWD/checkout_api_network.har" \
  --preset api \
  --url-pattern '**/api/**' \
  --method GET,POST \
  --port <reported port>

# Perform the interaction in the managed browser.

browser-tools record-har status --port <reported port> --json
browser-tools record-har stop --port <reported port>
```

`start` attaches a new owner-validated CDP session to the active tab and enables the Network domain before returning. `stop` waits for selected in-flight requests to finish and for a quiet period before writing standard HAR 1.2. Stop capture before stopping Chrome.

Resource presets:

- `api`: XHR, Fetch, Preflight, EventSource
- `page`: Document, Script, Stylesheet, XHR, Fetch
- `all`: every supported Network resource type

Supported `--resource-type` values are `Document`, `Stylesheet`, `Image`, `Media`, `Font`, `Script`, `TextTrack`, `XHR`, `Fetch`, `Prefetch`, `EventSource`, `Manifest`, `SignedExchange`, `Ping`, `CSPViolationReport`, `Preflight`, `FedCM`, and `Other`. Values are case-insensitive. Explicit resource types without `--preset` narrow capture to only those types. With a preset, explicit types extend it. WebSocket traffic requires raw CDP capture because it uses dedicated WebSocket protocol events rather than the HTTP loading events projected into HAR.

List-valued filters can be repeated or comma-separated. URL pattern flags must be repeated for multiple patterns, and each pattern is preserved verbatim so commas can match URL text:

- `--resource-type` and `--exclude-resource-type`
- `--url-pattern` and `--exclude-url-pattern`, using `*` and `?` globs
- `--method` and `--exclude-method`
- `--status` and `--exclude-status`, with values such as `200-299` or `404`
- `--mime-type` and `--exclude-mime-type`, using globs
- `--min-size` and `--max-size`, using encoded response bytes

Content and lifecycle controls:

- `--capture headers,bodies,timing`, all enabled by default; omitting `headers` also omits parsed request cookies
- `--max-body-bytes`, default 1 MiB per request or response body
- `--idle-ms`, default 500 ms quiet period on stop
- `--drain-timeout-ms`, default 5000 ms maximum drain wait
- `--max-duration`, default 300 seconds
- `--redact`, explicit filtering of sensitive-looking values
- `--overwrite`, explicit replacement of an existing output

HAR captures preserve raw debugging evidence by default, including authorization, cookies, API keys, tokens, and request or response bodies. Add `--redact` to filter sensitive-looking headers, query parameters, cookies, JSON fields, form fields, URL-valued headers, and initiator URLs while preserving structure. Binary response bodies use HAR base64 encoding. Outputs use owner-only file mode `0600`, but are not encrypted. The Browser Tools owner token is only used to authorize the CDP connection and is never written into the capture.

HAR represents HTTP request and response exchanges. Use raw CDP capture for WebSocket handshakes and frames, protocol events outside Network, or details that HAR cannot represent.

### Extract a network recipe

Convert a HAR into a compact chronological file that another agent can inspect:

```bash
browser-tools extract-har "$PWD/checkout_api_network.har" \
  --output "$PWD/checkout_api_recipe.json" \
  --preset api \
  --url-pattern '**/api/**'
```

The recipe preserves request order, resource type, method, URL, query parameters, headers, request body, response status, response body sample, timing, and failures. Its default `api` preset removes documents, scripts, images, fonts, and other page noise. It accepts the same resource, URL, method, status, and MIME filters as HAR capture.

`extract-har` does not execute or replay requests. Treat the recipe as evidence for authoring a separate script. Before executing any resulting script, identify dynamic values, authentication dependencies, anti-CSRF data, write side effects, retry behavior, and ordering constraints. Recipe files preserve source HAR values by default and use owner-only mode `0600`. Add `--redact` when exact sensitive values are not needed.

### Record raw CDP events

Use raw JSONL when an agent needs protocol details that HAR omits:

```bash
browser-tools record-cdp start \
  --output "$PWD/checkout_network_events.jsonl" \
  --domain Network \
  --event 'Network.*' \
  --exclude-event Network.dataReceived \
  --port <reported port>

# Perform the interaction.

browser-tools record-cdp status --port <reported port> --json
browser-tools record-cdp stop --port <reported port>
```

Each line contains `timestamp`, `elapsed_ms`, `method`, and `params`. Use repeated `--domain` to enable domains, repeated `--event` to include exact names or wildcards, and repeated `--exclude-event` to remove noisy events. If no selection is given, the recorder enables Network and captures `Network.*`.

Most event domains use `Domain.enable`. For a domain with another activation mechanism, use `--skip-enable <domain>` and one or more session setup calls:

```bash
browser-tools record-cdp start \
  --output "$PWD/target_lifecycle_events.jsonl" \
  --domain Target \
  --skip-enable Target \
  --setup '{"method":"Target.setDiscoverTargets","params":{"discover":true}}' \
  --event 'Target.*' \
  --port <reported port>
```

Setup methods use the same lifecycle safety block as direct CDP calls. Other controls are `--post-wait-ms` (default 500), `--max-duration` (default 300 seconds), `--max-events` (default 100000), `--redact`, and `--overwrite`. JSONL output preserves raw event payloads by default and uses owner-only mode `0600`. The event limit is a hard output bound, including during bursts and the post-wait period.

### Send direct CDP calls

Send a single method through an owner-validated session attached to the active tab:

```bash
browser-tools cdp call Runtime.evaluate \
  --params '{"expression":"document.title","returnByValue":true}' \
  --port <reported port>
```

Use `--params-file <path>` rather than inline JSON when parameters may be sensitive. Results preserve raw protocol values by default. Add `--redact` when exact sensitive values are not needed. Known lifecycle-bypass methods that close or crash the active page or Chrome, dispose contexts, detach targets, attach directly to the browser target, or tunnel nested protocol messages are blocked so Browser Tools managed state remains authoritative.

Direct CDP calls can mutate the sandboxed page or profile. Inspect the protocol method before calling it. The owner token authorizes the operation but is never sent as a protocol parameter or printed in output.

HAR and raw CDP recorders stay tied to the active tab selected at `start`. If the interaction changes to another tab or popup, stop and start a new meaningfully named capture for that target.

### Pick DOM elements

```bash
browser-tools pick "Click the price element"
```

In the browser:

- Click: select one element and finish
- Cmd/Ctrl+Click: add to multi-selection
- Enter: finish multi-selection
- Esc: cancel

## Implementation notes

`scripts/browser-control.mjs` owns port parsing, owner-token validation, per-port start locks, Chrome paths, private profile registry discovery, Profile Sync, launch and stop behavior, CDP connection, active page lookup, dedicated page lookup, safe disconnect, and artifact path creation.

`scripts/record-gif.mjs` owns the recording CLI lifecycle. `scripts/gif-recorder.mjs` owns detached recording state, owner verification, required pre-action and post-action capture, and periodic Puppeteer page capture. It sends each real page frame to ffmpeg as it is captured instead of accumulating frames in Node memory until stop. Periodic capture is required because Chrome emits native screencast frames only when the page paints, which cannot guarantee static pre-action and post-action frames.

`scripts/review-gif.mjs` owns post-recording media probing, bounded frame sampling, contact-sheet generation, and review metadata. It does not connect to Chrome and does not need an owner token.

`scripts/record-har.mjs`, `scripts/har-capture.mjs`, and `scripts/cdp-recording-state.mjs` own filtered HAR lifecycle, Network event projection, private state, body bounds, request draining, and HAR output. `scripts/extract-har.mjs` owns non-executable chronological recipe extraction.

`scripts/record-cdp.mjs` and `scripts/cdp-event-capture.mjs` own raw event selection and private JSONL output. `scripts/cdp.mjs` owns direct calls. `scripts/cdp-common.mjs` owns shared resource vocabulary, glob and status matching, redaction, meaningful private output paths, lifecycle-method blocking, and owner-validated active-tab sessions.

Generic extractors should use `scripts/resource-helper.mjs` for shared lifecycle. Domain-specific workflows should live in specialist skills and call Browser Tools as a dependency.
