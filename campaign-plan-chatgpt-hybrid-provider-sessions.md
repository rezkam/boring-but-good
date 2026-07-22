# Recovery plan: ChatGPT hybrid provider sessions

Status: approved by the user on 2026-07-21

Date: 2026-07-21

## Goal

Replace the stopped generic-Sentinel prototype with a ChatGPT transport that uses the actual ChatGPT UI for model selection, prompt entry, submission, and continuation. Use CDP network data and authenticated same-origin read endpoints for response streaming, conversation listing, final retrieval, and completion verification.

The transport must handle long Pro and Extra High turns without requiring one CLI process to remain attached until completion.

## Ratified decisions

1. UI submission is authoritative. The adapter does not synthesize or rewrite protected ChatGPT write requests.
2. ChatGPT conversation identity is provider-only. Public commands return and accept `provider_conversation_id`.
3. The adapter does not create local ChatGPT aliases, pending-turn files, conversation records, or query-cache entries.
4. Browser Tools may keep its existing private browser ownership file because managed-browser reuse requires it. This file is not ChatGPT conversation state.
5. ChatGPT stream mode writes NDJSON to stdout. Every line is one structured event and the final line is an explicit terminal event.
6. Non-streaming final retrieval returns one complete JSON object.
7. Continuation by provider conversation ID may use UI interaction.
8. Detached retrieval and continuation reject temporary mode because a completed temporary chat can have stream status but no retrievable conversation detail.
9. The supported model surface is exactly `instant`, `medium`, `high`, `extra-high`, and `pro`.
10. Actual UI model selection replaces backend payload rewriting. The observed request is used only to verify the selected model and effort.

## Observed provider contract

### Submission

The valid client handles conduit preparation, paid-account completion integrity, Turnstile, proof-of-work, authorization, and rotating integrity state. The adapter only controls the visible model and composer, then observes the resulting request and response.

### Read endpoints

Authenticated same-origin requests need the in-browser bearer and account headers, not cookies alone:

- `GET /backend-api/conversations`
- `GET /backend-api/conversation/<provider_conversation_id>`
- `GET /backend-api/conversation/<provider_conversation_id>/stream_status`

Authorization and account values remain inside Chrome.

### Terminal quorum

A persistent turn is complete only when both conditions hold:

1. Stream status is `COMPLETE`.
2. The current conversation branch ends at an assistant message with:
   - `channel: "final"`
   - `status: "finished_successfully"`
   - `end_turn: true`

`[DONE]` closes one SSE transport. It is not sufficient after a stream handoff. `message_stream_complete`, `assistant_turn_complete`, and `end_turn` are useful network evidence, but final output still reconciles against conversation detail.

### Structured turn data

The provider detail mapping can contain text, reasoning recap, citations, content references, search result groups, story events, model and effort metadata, request and turn IDs, tool messages, and timing fields.

Final output follows the current branch from its latest user message through the finished final assistant message. It preserves all response messages and known content types on that turn. It excludes prior turns, hidden system context, editable profile context, authorization values, cookies, security tokens, and resume tokens.

## Public command contract

### Submit and detach

```bash
scripts/ai-chat.mjs \
  --provider chatgpt \
  --model pro \
  --prompt-file ./question.md \
  --submit-only \
  --json
```

The command waits for an accepted conversation response and a real provider conversation ID. It then detaches its CDP observer while leaving the managed browser and ChatGPT page alive.

Expected output shape:

```json
{
  "provider": "chatgpt",
  "provider_conversation_id": "provider-id",
  "conversation_url": "https://chatgpt.com/c/provider-id",
  "status": "submitted",
  "complete": false
}
```

If ChatGPT accepts a request but does not expose an ID before the bounded ID timeout, the command fails without inventing an identifier. The error states that submission may have occurred.

### Watch an existing turn

```bash
scripts/ai-chat.mjs \
  --provider chatgpt \
  --conversation <provider-conversation-id> \
  --stream
```

This command performs authenticated direct reads and emits NDJSON. It does not depend on an earlier local process or checkpoint.

Event families:

- `session`: identifies provider conversation and source
- `status`: provider status changes and handoff state
- `delta`: text changes from an attached live stream
- `message`: new or changed structured turn messages
- `complete`: terminal event with full final turn data
- `timeout`: bounded wait ended while provider state remained incomplete
- `error`: sanitized provider or transport failure

Every event includes `provider`, `provider_conversation_id`, `event`, and `captured_at`. Secret material and progress prose never enter stdout.

A reattached watcher cannot replay bytes already delivered to an earlier CDP session. It starts with the current provider snapshot, emits later changes, and guarantees reconciliation to the final structured turn. Event metadata identifies `source: "live-cdp"` or `source: "provider-snapshot"`.

### Retrieve the final turn without streaming

```bash
scripts/ai-chat.mjs \
  --provider chatgpt \
  --conversation <provider-conversation-id> \
  --final \
  --json \
  --timeout 3600
```

The command polls provider status and detail until the terminal quorum is satisfied or the timeout expires. It never reports `complete: true` from stability, elapsed silence, `[DONE]` alone, or visible DOM text.

Expected complete result fields:

- `provider`
- `provider_conversation_id`
- `conversation_url`
- `status`
- `complete`
- `selected_model`
- `thinking_effort`
- `response`
- `turn.messages`
- `turn.user_message_id`
- `turn.assistant_message_id`
- `turn.turn_exchange_id`
- `turn.citations`
- `turn.content_references`
- `turn.search_result_groups`
- `turn.started_at`
- `turn.completed_at`
- `provider_state.stream_state`

A timeout returns structured incomplete state and a nonzero process status. It does not cache or save the partial turn.

### Continue a provider conversation

```bash
scripts/ai-chat.mjs \
  --provider chatgpt \
  --conversation <provider-conversation-id> \
  --prompt "Continue with the next step" \
  --model extra-high \
  --stream
```

The adapter opens `https://chatgpt.com/c/<provider-conversation-id>`, selects the model through the UI when `--model` is explicit, enters the new prompt, and submits through the UI. It then follows the same stream and final contracts.

When continuation omits `--model`, the adapter preserves the conversation UI selection and reports the observed backend model.

### List provider conversations

```bash
scripts/ai-chat.mjs \
  --provider chatgpt \
  --list-conversations \
  --json
```

This is a direct authenticated read. It returns provider IDs, URLs, titles, timestamps, current node IDs, async status, temporary flags, and archive/star status. It does not create local records.

## Invalid combinations

The adapter rejects before submission:

- ChatGPT `--save-conversation`
- ChatGPT `--attach-conversation`
- `--submit-only` without a prompt
- `--submit-only` with `--stream` or `--final`
- `--final` with a prompt
- `--final` without `--conversation`
- `--temporary` with `--submit-only`, `--conversation`, `--final`, or detached stream retrieval
- local ChatGPT aliases that do not resolve to a provider ID or trusted ChatGPT conversation URL

Explicit output paths remain allowed because the user requested those files. Automatic ChatGPT cache and conversation-store writes are disabled.

## Cross-cutting invariants

1. UI owns every ChatGPT write request. No Fetch request-body rewrite and no synthetic Sentinel flow exist.
2. ChatGPT chat identity and turn state are never persisted locally.
3. Provider credentials and security material stay in Chrome and never enter stdout, stderr, NDJSON, sidecars, screenshots, tests, or provider state.
4. Model selection is verified against visible UI state before submission and observed request model/effort after submission.
5. The adapter never marks a persistent turn complete without the terminal quorum.
6. Stream handoff and `[DONE]` are distinct states.
7. Reattached streaming is lossless for current and future provider snapshots, but does not claim byte-for-byte replay of earlier SSE data.
8. Full final data comes from the provider conversation mapping, not rendered DOM text.
9. Other providers retain their current cache, local conversation, and stream behavior.
10. Every timeout, partial result, fallback, model mismatch, and provider drift is explicit in output metadata.
11. No automated live test writes to ChatGPT or any other live service.

## Implementation slices

### Slice 1: Synchronous hybrid tracer bullet

Deliver one complete prompt-to-final path using UI submission and network response processing.

Changes:

- Restore only the useful UI-control and network-parser concepts from the committed adapter.
- Replace request payload rewriting with actual UI model and effort selection for all five profiles.
- Attach CDP before submission.
- Observe only the final `POST /backend-api/f/conversation`, not `/prepare`.
- Enable `Network.streamResourceContent` after `Network.responseReceived`.
- Decode buffered and incremental bytes across arbitrary chunk boundaries.
- Keep `Network.getResponseBody` only as a completion fallback when protocol streaming is unavailable.
- Parse SSE, handoff, and WebSocket catchup without DOM answer extraction.
- Fetch provider stream status and conversation detail inside Chrome.
- Build the terminal quorum and normalized final-turn result.
- Remove generic Sentinel submission and request rewriting from the runtime.

Acceptance:

- Each of the five profiles maps to one UI selection recipe and rejects unknown aliases.
- A deterministic CDP fixture proves buffered and incremental chunks produce the same final state without duplication.
- `[DONE]` after handoff remains incomplete.
- Terminal status without a finished final assistant remains incomplete.
- Finished final assistant without provider `COMPLETE` remains incomplete.
- The full quorum returns complete structured turn data.
- Runtime source has no generic Sentinel invocation, protected request synthesis, request-body rewrite, or DOM answer extraction.

Verification:

```bash
cd ai-chat
node --test test/chatgpt-provider.test.mjs
node --test test/provider-model-selection-matrix.test.mjs
node --test test/provider-tab-selection.test.mjs
```

### Slice 2: Stateless detach and final retrieval

Deliver provider-ID-only asynchronous operation.

Changes:

- Add `--submit-only` and `--final` parsing and validation.
- Return only a real `provider_conversation_id` from submit-only.
- Accept a provider ID or trusted ChatGPT URL directly in `--conversation`.
- Disable ChatGPT query cache, local conversation records, aliases, attach, and save behavior.
- Add direct authenticated final polling by provider ID.
- Add structured incomplete timeout output and nonzero CLI status.
- Reject detached temporary combinations before submission.

Acceptance:

- Submit-only returns after accepted response plus provider ID, without waiting for model completion.
- No ChatGPT file appears in the cache or conversation-store fixtures.
- A fresh process with only provider ID can retrieve a completed fixture.
- Final mode does not submit a prompt.
- Final mode never claims completion on either half of the quorum alone.
- Other providers retain existing local conversation behavior.

Verification:

```bash
cd ai-chat
node --test test/ai-chat-module.test.mjs
node --test test/chatgpt-provider.test.mjs
node --test test/public-surface.test.mjs
```

### Slice 3: NDJSON stream and reattachment

Deliver machine-readable live and detached progress.

Changes:

- Add an AI Chat-owned stream-event callback so providers do not write stdout directly.
- Emit ChatGPT NDJSON events with stable schemas.
- Stream exact incremental CDP data while attached.
- Reattach by provider ID through authenticated status/detail polling.
- Diff provider snapshots and emit changed messages without duplication.
- End only with `complete`, `timeout`, or `error`.
- Sanitize structured messages and metadata recursively.

Acceptance:

- Every stdout line parses independently as JSON.
- No progress prose, credential, token, cookie, hidden context, or resume token appears.
- Reattachment begins from a provider snapshot and emits only later changes.
- Repeated identical snapshots emit no duplicate message events.
- Completion emits exactly one terminal event with the final structured turn.
- Timeout emits exactly one terminal timeout event and exits nonzero.
- Non-ChatGPT `--stream` behavior is unchanged.

Verification:

```bash
cd ai-chat
node --test test/chatgpt-provider.test.mjs
node --test test/ai-chat-module.test.mjs
node --test test/browser-edge-cases.test.mjs
```

### Slice 4: Continuation, listing, docs, and surface cleanup

Deliver the complete user workflow and synchronize every public contract.

Changes:

- Continue an existing provider conversation through the UI.
- Preserve the current conversation model when no explicit model is supplied.
- Select and verify an explicit model through the UI when requested.
- Add direct `--list-conversations` reads.
- Remove all legacy ChatGPT aliases, generic-Sentinel documentation, request-rewrite claims, DOM answer fallback claims, and local ChatGPT session examples.
- Update skill, provider, transport, orchestration, evaluation, CLI, eval, and test contracts.

Acceptance:

- Provider ID plus prompt opens the correct trusted conversation URL and submits one new UI turn.
- Provider ID without prompt never submits.
- Listing is read-only and returns safe provider metadata.
- The public model surface is exactly the five ratified profiles.
- Source, tests, skill, references, and evals agree on provider-only state and NDJSON streaming.
- Static guards reject generic Sentinel, protected write replay, request rewrite, DOM answer extraction, and local ChatGPT conversation persistence.

Verification:

```bash
cd ai-chat
node --test test/chatgpt-provider.test.mjs
node --test test/ai-chat-module.test.mjs
node --test test/provider-model-selection-matrix.test.mjs
node --test test/provider-tab-selection.test.mjs
node --test test/public-surface.test.mjs
npm test
```

## Verification policy

- All deterministic tests use fake pages, fake CDP sessions, and captured redacted response shapes.
- Tests prove stream parsers with chunk boundaries, handoff, duplicated snapshots, final quorum, tool/citation message types, and secret redaction.
- Tests prove no ChatGPT cache or conversation record is written.
- Live verification during the campaign is read-only: auth, model-list visibility, conversation list, conversation detail, and stream status.
- Automated live tests never create, continue, modify, archive, or delete provider conversations.
- The first real write after delivery remains an operational verification against current provider UI. Provider drift risk must remain explicit until that occurs.

## Campaign environment

A fresh isolated worktree preserves the stopped prototype unchanged:

- Branch: `feat/ai-chat-chatgpt-hybrid-sessions`
- PR title: `feat(ai-chat): add resumable ChatGPT provider sessions`
- Implementation notes are untracked.

PR #15 currently owns overlapping AI Chat core changes and is still open at `1b7b6cdb62a4f14a92efdbe3bd65308c437a035d`. The new branch will start from that verified head and the PR will initially target `feat/ai-chat-perplexity-network`. After PR #15 merges, the coordinator will rebase or retarget the ChatGPT PR to `main`. This plan does not authorize merging PR #15.

This approved plan is the committed decision record for the campaign.

## Implementation lane

- Four serial implementation slices
- Effort: medium, pinned for every slice
- One slice in flight at a time
- Implementers commit locally with Conventional Commits
- Coordinator verifies, pushes, owns the PR, and updates living docs
- Final adversarial review: high effort, up to three rounds

## Living documentation

Update in the same changes that alter behavior:

- `ai-chat/SKILL.md`
- `ai-chat/references/ai-chat.md`
- `ai-chat/references/providers.md`
- `ai-chat/references/transport.md`
- `ai-chat/references/orchestration.md`
- `ai-chat/references/evaluation.md`
- `ai-chat/evals/evals.json`
- relevant provider, module, matrix, tab-selection, browser-edge, and public-surface tests

Private campaign memory remains outside commits:

- untracked implementation notes
- private redacted browser artifacts

## Stop conditions

Stop and report if any of these occurs:

1. Actual UI model selection cannot reliably distinguish the five profiles without request rewriting.
2. ChatGPT does not expose a provider conversation ID soon enough for safe submit-only return.
3. Provider status/detail endpoints cannot reconstruct in-progress and final state from provider ID alone.
4. Correct behavior would require local ChatGPT chat or turn persistence.
5. Correct behavior would require exporting credentials or security material from Chrome.
6. NDJSON requires a breaking change to another provider instead of an isolated ChatGPT path.
7. One slice reaches three failed verify-fix rounds.
8. Three adversarial review rounds leave confirmed P0 through P2 defects open.
9. The provider changes the contract enough to require a new slice or architecture.
