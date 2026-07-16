# @rezkam/browser-tools

## 0.2.1

### Patch Changes

- 8ea5041: Verify automated npm publishing after the initial package release.

## 0.2.0

### Minor Changes

- 85e2099: Publish Browser Tools as an installable npm package, `@rezkam/browser-tools`, with a `browser-tools` CLI (`start`, `status`, `stop`, `nav`, `eval`, `screenshot`, `pick`, `config`, `scrape-page`, `extract-article`) and a programmatic export of the browser control module, so external consumers can depend on a pinned version instead of a cloned script path. The skill's existing `scripts/*.mjs` interface for agents working directly in this repo is unchanged.
