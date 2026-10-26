# Pi extensions

Pi extensions live here as harness resources, separately from workflow skills under `skills/`.

Each extension directory contains its entry point, supporting modules, tests, and installation instructions. Install an extension by following its own README:

- [Gemini Search](gemini-search/README.md)
- [Goal](goal/README.md)

## Development

```bash
npm --prefix extensions install
npm --prefix extensions run validate
```
