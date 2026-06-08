# Evaluation and Verification

Use skill-creator evals for prompt-level behavior and direct tests for helper contracts.

## Required checks before calling a provider feature working

1. `npm test` passes.
2. Live run with the provider returns non-empty output.
3. Model selection is either verified or explicitly reported as unverified.
4. Continued conversation is verified by a second prompt using the same saved conversation id.
5. Screenshot evidence is captured for browser UI providers.
6. Browser started for the task is stopped and cleaned.

## Live evidence layout

Use `/tmp/ai-chat-verify/<provider>/<case>/`:

- `request.json` or prompt file
- `response.json`
- `stderr.log`
- `screenshot.png` when browser UI is involved
- `notes.md` for observed limitations

## Live evidence rules

Do not commit live evidence outputs. They can contain account-visible model lists, provider state, conversation text, screenshots, or local profile labels. Keep them under `/tmp/ai-chat-verify/...` or another private scratch directory.

## Skill evals

The eval set should cover:

- Perplexity model listing and deep research routing
- saved conversation and follow-up continuation
- account-specific model discovery with `--verify-models`
- Grok model selection and reasoning/non-reasoning behavior
- ChatGPT visible model discovery and temporary chat
- Gemini RPC model discovery and temporary/history behavior
- fallback and failure reporting
