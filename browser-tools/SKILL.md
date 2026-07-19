---
name: browser-tools
description: "Control a sandboxed Chrome browser with a copied profile, including launch, stop, navigation, page JavaScript evaluation, screenshots, GIF recording and contact-sheet review, filtered HAR capture, agent-readable network extraction, raw CDP event recording, direct owner-protected CDP calls, DOM picking, page link extraction, article extraction, local profile configuration, and safe managed-browser ownership. Use this skill whenever the user asks to open or inspect a website, scrape a generic page, use a logged-in browser session, record or review browser interactions, capture XHR or Fetch traffic, create a HAR, inspect network requests, use Chrome DevTools Protocol, derive API calls from browser behavior, visually review a multi-step flow, take screenshots, evaluate browser JavaScript, manage Chrome profiles for agents, or control browser tabs. Do not use it for finance-specific data workflows, use the finance skill instead."
compatibility: "Requires the @rezkam/browser-tools npm package (npm install -g @rezkam/browser-tools, or npx @rezkam/browser-tools), macOS Chrome, Node.js 20+, ffmpeg and ffprobe for GIF recording and review, and network access for browser automation."
---

# Browser Tools

Browser Tools is the generic managed Chrome layer. It launches a sandboxed Chrome, copies selected profile state when needed, protects each browser with an owner token, and exposes a safe CLI for browser control.

Use Browser Tools for general browser work. Use specialist skills for domain workflows such as finance data.

## Setup

This skill drives the `@rezkam/browser-tools` npm package's CLI, so the package must be installed before anything else:

```bash
npm install -g @rezkam/browser-tools
```

This provides the global `browser-tools` command used throughout this skill and its reference doc. If a global install is not wanted, run every command through `npx @rezkam/browser-tools <subcommand>` instead (for example `npx @rezkam/browser-tools start --headless`).

GIF recording and contact-sheet review require ffmpeg and its ffprobe tool:

```bash
brew install ffmpeg
```

## Quick start

```bash
browser-tools start
export BROWSER_TOOLS_OWNER_TOKEN="<owner token from start output>"
browser-tools nav https://example.com --port <reported port>
browser-tools eval 'document.title' --port <reported port>
browser-tools screenshot --full --port <reported port>
browser-tools status --port <reported port>
browser-tools stop --port <reported port>
```

Every `browser-tools` subcommand dispatches to the package's `scripts/` sources unchanged; there are no separate root-level compatibility wrappers.

## Browser Control

| Task | Command |
| --- | --- |
| Configure private Browser Tools config | `browser-tools config profiles`, `browser-tools config active-profiles`, `browser-tools config task-profile set <task> --profile "<alias>"` |
| Start Chrome | `browser-tools start`, `browser-tools start --profile "<Chrome profile folder or local alias>"`, `browser-tools start --task <task>`, or `browser-tools start --headless` |
| Check status | `browser-tools status`, `browser-tools status --port <n> --json` |
| Stop Chrome | `browser-tools stop --clean` |
| Navigate | `browser-tools nav https://example.com` |
| Evaluate JavaScript | `browser-tools eval 'document.title'` |
| Screenshot | `browser-tools screenshot --full` |
| Record active tab as GIF | `browser-tools record-gif start --output ./login_process.gif`, then `browser-tools record-gif stop` |
| Check GIF recording | `browser-tools record-gif status --json` |
| Probe GIF and create contact sheet | `browser-tools review-gif ./login_process.gif` |
| Record filtered HAR | `browser-tools record-har start --output ./checkout_api_network.har --preset api` |
| Extract agent-readable network recipe | `browser-tools extract-har ./checkout_api_network.har` |
| Record raw CDP events | `browser-tools record-cdp start --output ./checkout_network_events.jsonl --domain Network` |
| Send direct CDP call | `browser-tools cdp call Runtime.evaluate --params '{"expression":"document.title"}'` |
| Pick DOM element | `browser-tools pick "Click the price"` |
| Extract article-like visible links from the current page | `browser-tools scrape-page` |
| Extract article text from the current page | `browser-tools extract-article --chars 6000` |

Read [browser-control.md](references/browser-control.md) when you need profile names, private config behavior, port behavior, GIF recording options, DOM picking controls, directory defaults, or implementation details.

## Visual interaction recording

When performing multi-step browser interactions, a GIF might be helpful to see what is happening and keep the full interaction visually clear. Use GIF recording when the user wants visual inspection or when seeing the sequence will make verification easier. Record the active tab selected at start:

```bash
browser-tools record-gif start --output "$PWD/login_process.gif" --port <reported port>
# Perform the browser actions.
browser-tools record-gif stop --port <reported port>
```

For every recording, follow these rules because the first and final states need enough screen time to be understandable:

- **Always capture extra frames before and after taking actions.** Start recording before the first action. `start` waits while it captures pre-action frames, so actions can begin as soon as the command returns. Stop only after the final action. `stop` captures post-action frames before finalizing.
- **Always name the GIF meaningfully.** Use an action-specific filename that tells the user what the GIF shows, such as `login_process.gif` or `checkout_validation.gif`. The command requires `--output` and rejects generic names such as `recording.gif`.
- Stop the recording before stopping Chrome. A recording is tied to the active tab selected at `start`; if the flow moves to a new tab, stop and start a new meaningfully named recording for that tab.

After recording, probe the GIF and create a contact sheet so the sequence can be checked without replaying every frame:

```bash
browser-tools review-gif "$PWD/login_process.gif"
```

Read the generated contact-sheet PNG and confirm that it shows the initial state, the important action states, and the final state. If the first or final state is unclear, repeat the recording with longer `--pre-roll-ms` or `--post-roll-ms`. The review command also writes JSON metadata with frame count, duration, frame rate, dimensions, and sampling details under the GIF's `.gif-review/` directory. The review directory is owner-only `0700`, and the contact sheet and metadata are owner-only `0600`.

The default recording safety limit is 120 seconds. Use `browser-tools record-gif status --port <reported port> --json` to inspect a recorder that may still be running.

## Network capture and CDP

Use the network tools when an agent needs to observe a browser interaction and then understand how to reproduce its HTTP behavior. All live capture and CDP commands require the same `BROWSER_TOOLS_OWNER_TOKEN` and reported port as other Browser Control commands.

### Record and extract an interaction

Start HAR capture before the interaction, perform the browser actions, then stop capture after the relevant requests complete:

```bash
browser-tools record-har start \
  --output "$PWD/checkout_api_network.har" \
  --preset api \
  --resource-type XHR,Fetch \
  --url-pattern '**/api/**' \
  --port <reported port>

# Perform the browser interaction.

browser-tools record-har stop --port <reported port>
browser-tools extract-har "$PWD/checkout_api_network.har" \
  --output "$PWD/checkout_api_recipe.json"
```

`record-har` writes standard HAR 1.2 and can filter resource types, URL globs, methods, statuses, MIME types, and encoded sizes. Presets are `api`, `page`, and `all`. Explicit `--resource-type` values without a preset narrow capture to only those types.

The extracted recipe removes page noise and preserves chronological request structure, bodies, response samples, and timing so an agent can write a separate fetch, curl, or browser-backed script. It does not execute requests. Never execute or replay captured write requests without reviewing authentication, dynamic values, ordering dependencies, and side effects first.

Captures preserve raw request and response evidence by default because exact headers, cookies, tokens, and bodies are often required for debugging. Add `--redact` when exact sensitive values are not needed. Capture files use owner-only mode `0600`, but they are not encrypted. Never commit or share a raw sensitive capture.

### Record raw protocol events

HAR cannot represent every CDP domain or event. Use raw JSONL capture when protocol-level evidence is needed:

```bash
browser-tools record-cdp start \
  --output "$PWD/checkout_network_events.jsonl" \
  --domain Network \
  --event 'Network.*' \
  --exclude-event Network.dataReceived \
  --port <reported port>

# Perform the browser interaction.

browser-tools record-cdp stop --port <reported port>
```

Use repeated `--domain`, `--event`, and `--exclude-event` options for precise control. For domains without `Domain.enable`, use `--skip-enable <domain>` and an owner-approved `--setup` CDP command. Raw event payloads are unredacted by default. Add `--redact` when exact protocol values are not needed.

### Send direct CDP calls

```bash
browser-tools cdp call Runtime.evaluate \
  --params '{"expression":"document.title","returnByValue":true}' \
  --port <reported port>
```

Prefer `--params-file` when parameters contain sensitive values, because command arguments can be visible in process listings. Direct results are raw by default. Add `--redact` to filter sensitive-looking fields. Known methods that bypass managed-browser lifecycle safety, including `Browser.close`, are blocked.

Capture is tied to the active tab selected at `start`. If an interaction moves to a new tab, stop the current capture and start a meaningfully named capture for the new tab.

## Package details

`@rezkam/browser-tools` also exposes the browser control module for direct programmatic import: `import { connectBrowser } from '@rezkam/browser-tools'`. See [README.md](README.md) for the npm-consumer-facing documentation, including the full CLI subcommand reference.

## Defaults

- Start with `browser-tools start` for a fresh browser.
- Add `--profile "<Chrome profile folder or local alias>"` only when logged-in browser access is needed.
- Use `--task <task>` to start with a configured profile for a specialist skill or workflow.
- If cookies must be current, start with `--sync` or restart with `--sync` after a login mismatch.
- The clone excludes the Google identity by default. Cookies for the whole Google ecosystem (google.com and its services like Gmail, Drive, Docs, Photos, Play, Cloud, Gemini, plus YouTube and related Google domains) and the Google OAuth token are stripped from the copy, so a live clone cannot log your main Chrome out of Google. All other site logins are kept. Add `--include-google` only for Google-backed workflows (for example ai-chat's Gemini), which re-introduces that logout risk.
- Add `--headless` to run without opening a browser window when the task needs no user interaction. It runs the full browser (profile and extensions still load), so navigation, evaluation, scraping, and screenshots behave the same. Headless presents the normal Chrome User-Agent instead of `HeadlessChrome` so a Google-signed-in clone does not trip session-theft protection and log the source profile out. Headless is set at start time; to change it, stop with `--clean` and start again.
- If the default port is busy, `browser-tools start` auto-allocates another port and creates a separate per-port sandbox profile copy. Use the reported port for follow-up commands.
- Each start owns the browser with an owner token. Export the printed token as `BROWSER_TOOLS_OWNER_TOKEN` for follow-up commands. Avoid passing user-supplied tokens with `--owner-token` because command-line arguments can be visible to other local users through process listings.
- Open new browser tabs in the background with `browser.newPage({ background: true })` so automation does not steal OS focus from the user. Do not call `page.bringToFront()` unless the user explicitly asks to see or interact with that tab.
- For multi-step visual recordings, always capture extra frames before and after actions, always use an action-specific GIF filename, then inspect the `review-gif` contact sheet for initial, action, and final states.
- Network and CDP capture must use the managed browser's owner token. Preserve raw evidence by default for debugging, and add `--redact` when exact sensitive values are not needed.
- Send useful result data to stdout. Treat stderr as progress and diagnostics.

## Local config and directories

Browser Tools works out of the box with these defaults:

- Config: `~/.agents/browser-tools/config.json`
- Chrome source profile directory: `~/Library/Application Support/Google/Chrome`
- Managed browser cache and copied profiles: `~/.cache/pi-browser-tools`
- Artifact output directory: `/tmp`
- Chrome binary: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`

`browser-tools config profiles` creates or refreshes config from Chrome `Local State`. The config can override `directories.chromeSourceDir`, `directories.cacheDir`, `directories.artifactDir`, `browser.chromeBin`, profile aliases, and task profile preferences. Environment variables take precedence for process-level overrides: `BROWSER_TOOLS_CONFIG_DIR`, `BROWSER_TOOLS_CACHE_DIR`, `BROWSER_TOOLS_ARTIFACT_DIR`, `BROWSER_TOOLS_CHROME_SOURCE_DIR`, and `BROWSER_TOOLS_CHROME_BIN`.

Private profile labels, account names, active-profile cache, aliases, and task profile preferences belong in the local config, never in this repo.

## Gotchas

- The sandboxed Chrome profile is a per-port copy in the configured cache directory, not the live Chrome profile.
- A copied profile can be stale. If a site where the live Chrome profile is logged in opens as logged out, stop the managed browser with the owner token and `--clean`, then start again with the same profile plus `--sync`.
- Managed Chrome keeps copied profile extensions, extension payloads, and extension state so the sandbox resembles the original profile. Chrome sync stays disabled so the sandbox does not sync mutations back through the browser account.
- `browser-tools stop` only stops a managed Chrome process launched by `browser-tools start` when the owner token matches. It refuses to kill the main Chrome, another agent's browser, or any reused/manual browser process.
- Browser Tools commands, GIF recorders, network/CDP captures, and generic extractors must not connect to another agent's browser, a manual browser, or the main Chrome DevTools session.
