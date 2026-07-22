# @rezkam/browser-tools

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
