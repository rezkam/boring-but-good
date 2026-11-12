# Pi extensions

Pi extensions live here as harness resources, separately from workflow skills under `skills/`.

Each extension directory contains its entry point, supporting modules, tests, and installation instructions. Install an extension by following its own README:

- [Codex fast mode](codex-fast-mode/README.md)
- [Goal](goal/README.md)
- [Codex Limits Status](codex-limits-status/README.md) — percentage used and a compact reset countdown for `openai-codex*` providers.

## Development

```bash
npm --prefix extensions install
npm --prefix extensions run validate
```
