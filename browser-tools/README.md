# @rezkam/browser-tools

Sandboxed, owner-token-protected Chrome automation for AI agents: launch a managed Chrome with a copied profile, navigate, evaluate page JavaScript, screenshot, and stop it safely, all without touching your main Chrome.

This package is the npm-installable form of the `browser-tools` skill in [boring-but-good](https://github.com/rezkam/boring-but-good/tree/main/browser-tools). The skill itself now drives this package's CLI, so there is one supported way to run Browser Tools whether you got here through the skill or through npm directly.

## Install

Two independent installs, pick what you need:

**The skill** (for an agent that should discover and use Browser Tools as a skill):

```bash
npx skills add rezkam/boring-but-good --skill browser-tools
```

**The package/CLI** (what the skill depends on, and what any project can depend on directly):

```bash
npm install -g @rezkam/browser-tools
```

This installs a global `browser-tools` command (via the package's `bin` entry) and, for programmatic use, exports the browser control module. If you would rather not install it globally, run any command through `npx @rezkam/browser-tools <subcommand>` instead.

GIF recording and review also require ffmpeg and its ffprobe tool:

```bash
brew install ffmpeg
```

## CLI

Each subcommand dispatches to the matching script unchanged; flags are the same as the underlying script.

```bash
browser-tools start --task <task> --headless      # launch, prints an owner token on first start
export BROWSER_TOOLS_OWNER_TOKEN="<owner token from start output>"
browser-tools status --port <reported port>        # report whether it's running
browser-tools nav https://example.com --port <reported port>
browser-tools eval 'document.title' --port <reported port>
browser-tools screenshot --full --port <reported port>
browser-tools record-gif start --output "$PWD/login_process.gif" --port <reported port>
# Perform the multi-step interaction.
browser-tools record-gif stop --port <reported port>
browser-tools review-gif "$PWD/login_process.gif"
browser-tools record-har start --output "$PWD/checkout_api_network.har" --preset api --port <reported port>
# Perform the browser interaction, then stop and extract a non-executable recipe.
browser-tools record-har stop --port <reported port>
browser-tools extract-har "$PWD/checkout_api_network.har"
browser-tools record-cdp start --output "$PWD/checkout_network_events.jsonl" --domain Network --event 'Network.*' --port <reported port>
browser-tools record-cdp stop --port <reported port>
browser-tools cdp call Runtime.evaluate --params '{"expression":"document.title"}' --port <reported port>
browser-tools pick "Click the price" --port <reported port>
browser-tools scrape-page --port <reported port>
browser-tools extract-article --chars 6000 --port <reported port>
browser-tools stop --clean --port <reported port>
browser-tools config task-profile set <task> --profile "<alias>"
```

Run `browser-tools --help` for the full command list.

## Programmatic use

```js
import { connectBrowser, activePage, withBrowser } from '@rezkam/browser-tools';
```

`@rezkam/browser-tools` and `@rezkam/browser-tools/browser-control.mjs` both resolve to the browser control module (launch, stop, profile sync, owner-token safety, CDP connect). `@rezkam/browser-tools/resource-helper.mjs` resolves to the shared generic-extractor lifecycle helper.

## Behavior notes

- Headless (`--headless`) runs full Chrome (`--headless=new`), not the legacy no-extensions engine, so profile, cookies, and extensions load the same as a windowed launch.
- Profile Sync excludes the Google identity from a copied profile by default, so a clone cannot log your main Chrome out of Google; pass `--include-google` only for Google-backed workflows.
- Every managed browser is owned by a token printed at `start`; `stop` refuses to kill a browser it does not own, another agent's browser, or your main Chrome.
- GIF recording requires an explicit action-specific output name. `start` captures pre-action frames before returning, and `stop` captures post-action frames before finalizing the GIF.
- `review-gif` probes frame count, duration, frame rate, and dimensions, then creates a sampled contact sheet and JSON report under the GIF's `.gif-review/` directory.
- `record-har` captures owner-protected filtered active-tab HTTP traffic as private HAR 1.2. `extract-har` derives a compact chronological recipe without executing requests.
- `record-cdp` writes selected raw protocol events as private JSONL. `cdp call` sends one owner-protected active-tab method while blocking known managed-lifecycle bypasses.
- HAR, recipes, raw CDP events, and direct results preserve exact debugging evidence by default. Add `--redact` to filter sensitive-looking values. Capture files are owner-only `0600`, not encrypted.
- Config, cache, and artifact directories default to `~/.agents/browser-tools/config.json`, `~/.cache/pi-browser-tools`, and `/tmp`, overridable via `BROWSER_TOOLS_CONFIG_DIR`, `BROWSER_TOOLS_CACHE_DIR`, `BROWSER_TOOLS_ARTIFACT_DIR`, `BROWSER_TOOLS_CHROME_SOURCE_DIR`, and `BROWSER_TOOLS_CHROME_BIN`.
- Requires macOS Chrome and Node.js 20+. GIF recording and review require ffmpeg and ffprobe.

For the full behavior reference (profile sync internals, ownership rules, stop safety checks, gotchas), see the skill docs in the source repository: [SKILL.md](https://github.com/rezkam/boring-but-good/blob/main/browser-tools/SKILL.md) and [references/browser-control.md](https://github.com/rezkam/boring-but-good/blob/main/browser-tools/references/browser-control.md).

## Testing

```bash
npm test             # Fast unit and CLI contract tests
npm run test:e2e     # Real headless Chrome and ffmpeg GIF interaction test
npm run validate     # Both suites
```

The E2E tests use real Chrome, ffmpeg, and ffprobe against local isolated fixtures. GIF tests validate recording, private output, and contact-sheet review. Network tests validate raw filtered HAR capture, optional recipe redaction, raw wildcard CDP events, direct CDP calls, owner-token refusal, private file modes, hard event limits, and lifecycle-method blocking. They do not use a live account or external server.

## License

Apache-2.0
