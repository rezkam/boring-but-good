---
name: browser-tools
description: "Control a sandboxed Chrome browser with a copied profile, including launch, stop, navigation, page JavaScript evaluation, screenshots, DOM picking, page link extraction, article extraction, local profile configuration, and safe managed-browser ownership. Use this skill whenever the user asks to open or inspect a website, scrape a generic page, use a logged-in browser session, take screenshots, evaluate browser JavaScript, manage Chrome profiles for agents, or control browser tabs. Do not use it for finance-specific data workflows, use the finance skill instead."
compatibility: "Requires macOS Chrome, Node.js 20+, npm dependencies from package.json, and network access for browser automation."
---

# Browser Tools

Browser Tools is the generic managed Chrome layer. It launches a sandboxed Chrome, copies selected profile state when needed, protects each browser with an owner token, and exposes safe scripts for browser control.

Use Browser Tools for general browser work. Use specialist skills for domain workflows such as finance data.

## Quick start

```bash
scripts/start.mjs
export BROWSER_TOOLS_OWNER_TOKEN="<owner token from start output>"
scripts/nav.mjs https://example.com --port <reported port>
scripts/eval.mjs 'document.title' --port <reported port>
scripts/screenshot.mjs --full --port <reported port>
scripts/stop.mjs --port <reported port>
```

All executable scripts live under `scripts/`. There are no root-level compatibility wrappers.

## Browser Control

| Task | Script |
| --- | --- |
| Configure private Browser Tools config | `scripts/config.mjs profiles`, `scripts/config.mjs active-profiles`, `scripts/config.mjs task-profile set <task> --profile "<alias>"` |
| Start Chrome | `scripts/start.mjs`, `scripts/start.mjs --profile "<Chrome profile folder or local alias>"`, `scripts/start.mjs --task <task>`, or `scripts/start.mjs --headless` |
| Stop Chrome | `scripts/stop.mjs --clean` |
| Navigate | `scripts/nav.mjs https://example.com` |
| Evaluate JavaScript | `scripts/eval.mjs 'document.title'` |
| Screenshot | `scripts/screenshot.mjs --full` |
| Pick DOM element | `scripts/pick.mjs "Click the price"` |
| Extract article-like visible links from the current page | `scripts/scrape-page.mjs` |
| Extract article text from the current page | `scripts/extract-article.mjs --chars 6000` |

Read [browser-control.md](references/browser-control.md) when you need profile names, private config behavior, port behavior, DOM picking controls, directory defaults, or implementation details.

## Defaults

- Start with `scripts/start.mjs` for a fresh browser.
- Add `--profile "<Chrome profile folder or local alias>"` only when logged-in browser access is needed.
- Use `--task <task>` to start with a configured profile for a specialist skill or workflow.
- If cookies must be current, start with `--sync` or restart with `--sync` after a login mismatch.
- The clone excludes the Google identity by default. Cookies for the whole Google ecosystem (google.com and its services like Gmail, Drive, Docs, Photos, Play, Cloud, Gemini, plus YouTube and related Google domains) and the Google OAuth token are stripped from the copy, so a live clone cannot log your main Chrome out of Google. All other site logins are kept. Add `--include-google` only for Google-backed workflows (for example ai-chat's Gemini), which re-introduces that logout risk.
- Add `--headless` to run without opening a browser window when the task needs no user interaction. It runs the full browser (profile and extensions still load), so navigation, evaluation, scraping, and screenshots behave the same. Headless presents the normal Chrome User-Agent instead of `HeadlessChrome` so a Google-signed-in clone does not trip session-theft protection and log the source profile out. Headless is set at start time; to change it, stop with `--clean` and start again.
- If the default port is busy, `scripts/start.mjs` auto-allocates another port and creates a separate per-port sandbox profile copy. Use the reported port for follow-up commands.
- Each start owns the browser with an owner token. Export the printed token as `BROWSER_TOOLS_OWNER_TOKEN` for follow-up commands. Avoid passing user-supplied tokens with `--owner-token` because command-line arguments can be visible to other local users through process listings.
- Open new browser tabs in the background with `browser.newPage({ background: true })` so automation does not steal OS focus from the user. Do not call `page.bringToFront()` unless the user explicitly asks to see or interact with that tab.
- Send useful result data to stdout. Treat stderr as progress and diagnostics.

## Local config and directories

Browser Tools works out of the box with these defaults:

- Config: `~/.agents/browser-tools/config.json`
- Chrome source profile directory: `~/Library/Application Support/Google/Chrome`
- Managed browser cache and copied profiles: `~/.cache/pi-browser-tools`
- Artifact output directory: `/tmp`
- Chrome binary: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`

`scripts/config.mjs profiles` creates or refreshes config from Chrome `Local State`. The config can override `directories.chromeSourceDir`, `directories.cacheDir`, `directories.artifactDir`, `browser.chromeBin`, profile aliases, and task profile preferences. Environment variables take precedence for process-level overrides: `BROWSER_TOOLS_CONFIG_DIR`, `BROWSER_TOOLS_CACHE_DIR`, `BROWSER_TOOLS_ARTIFACT_DIR`, `BROWSER_TOOLS_CHROME_SOURCE_DIR`, and `BROWSER_TOOLS_CHROME_BIN`.

Private profile labels, account names, active-profile cache, aliases, and task profile preferences belong in the local config, never in this repo.

## Gotchas

- The sandboxed Chrome profile is a per-port copy in the configured cache directory, not the live Chrome profile.
- A copied profile can be stale. If a site where the live Chrome profile is logged in opens as logged out, stop the managed browser with the owner token and `--clean`, then start again with the same profile plus `--sync`.
- Managed Chrome keeps copied profile extensions, extension payloads, and extension state so the sandbox resembles the original profile. Chrome sync stays disabled so the sandbox does not sync mutations back through the browser account.
- `scripts/stop.mjs` only stops a managed Chrome process launched by `scripts/start.mjs` when the owner token matches. It refuses to kill the main Chrome, another agent's browser, or any reused/manual browser process.
- Browser Tools scripts and generic extractors must not connect to another agent's browser, a manual browser, or the main Chrome DevTools session.
