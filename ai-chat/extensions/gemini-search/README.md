# Gemini Search extension for pi

This extension adds one tool to pi: `gemini_search`.

It is a small wrapper around the AI Chat Gemini provider. Every query uses:

- the Gemini 3.6 Flash Extended Thinking UI mode, verified before submission
- Browser Tools managed Chrome from `@rezkam/browser-tools`
- a verified Gemini temporary chat
- Google identity included only in the managed profile copy
- a web-search prompt that requires direct source URLs
- private result files instead of large inline tool results

## Install

From this repository checkout:

```bash
cd ai-chat
npm install
pi install .
```

For a one-session test without installing:

```bash
cd ai-chat
pi -e .
```

## Browser profile

The extension reads the private Browser Tools task profile named `gemini`:

```bash
browser-tools config task-profile set gemini --profile "<profile-alias>"
```

The profile label remains in Browser Tools private configuration. It is not written to result files or pi tool results.

For a process-local override, set `GEMINI_SEARCH_BROWSER_PROFILE` before starting pi. Do not put private profile labels in repository configuration.

## Tool input

Use one query:

```json
{
  "query": "Current stable runtime release and official source"
}
```

Or use up to five distinct queries:

```json
{
  "queries": [
    "Current stable runtime release and official source",
    "Current support schedule from the official project",
    "Recent compatibility guidance from browser vendors"
  ]
}
```

Queries run sequentially because each AI Chat Gemini request owns and closes its managed browser. This avoids browser state races when pi executes tool calls in parallel.

## Results

Each successful query produces a Markdown file with mode `0600` under the extension's private result directory:

```text
<private-output-dir>/gemini-search/
```

The directory uses mode `0700`. An existing directory with broader permissions is refused. Result files are verified as mode `0600` after writing.

The tool result sent to the agent contains only completion status and a home-relative result-file path represented here as `<home-relative-result-path>`. Pi's `read` tool expands the runtime path, so the agent can read the file without receiving the absolute host home path.

The Gemini WebUI response does not expose an independently trustworthy backend model identifier. The extension verifies the exact selected UI mode before submission and reports that scope accurately. It refuses a result that contains no direct source URL.

Gemini responses, prompts, account metadata, cookies, and profile labels must not be committed.

## Progress and cancellation

The tool row shows per-query progress while pi waits. The extension does not write to the footer status, the widget area, or any other shared chrome, so the editor keeps its normal shape and stays usable during a search. Expanded results show file paths and sanitized per-query failures.

Escape cancels a search. A queued search stops before it acquires the browser, and an in-flight search returns immediately while its browser session is still allowed to close. If pi exits while a search is running, the extension stops the browser that search started.

A queued search cancels immediately before it acquires the managed browser. An active invocation reports cancellation immediately, while its underlying Gemini browser request continues only until its own cleanup finishes. The next search remains queued until that cleanup is complete, so browsers cannot overlap. Completed result paths remain available.
