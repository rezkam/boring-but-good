# AI Chat Provider Orchestration Contract

This records the implementation contract for the AI Chat provider unification work.

## Decision

AI Chat is the single multi-provider entry point for browser-authenticated Grok, ChatGPT, Gemini, and Perplexity work. Provider-specific skills can remain as references or deeper workflows, but AI Chat owns the common command shape, browser lifecycle, local conversation records, cache policy, metadata shape, output artifacts, and cross-provider verification.

Provider adapters own provider-specific behavior only. They may build provider request payloads, parse provider streams, resolve provider model ids, and return provider state. Providers that require explicit cookie APIs may read only from the managed browser. Perplexity is stricter: credentials stay inside same-origin browser fetch and its adapter must not read cookie values. Adapters must not start or stop Chrome, write browser ownership state, choose global cache behavior, or emit private tokens to normal output.

## Browser ownership lifecycle

AI Chat owns one Browser Tools managed Chrome session for normal AI Chat use.

- Startup: when a request needs browser access and no usable AI Chat owned browser exists, AI Chat starts Browser Tools with owner id `ai-chat`, Browser Tools task profile `ai-chat`, and fallback Chrome profile `Default` when no task profile is configured. The current CLI exposes `--port` for the preferred debug port. Browser Tools auto-allocates another port when the default is busy and the port was not explicit.
- Reuse: later AI Chat requests load the private AI Chat browser state, then connect only when Browser Tools safety checks, the owner token, and copied profile presence pass. The same owned browser is reused across providers.
- Refusal: AI Chat refuses unmanaged Chrome, missing Browser Tools managed state, a browser owned by another agent, missing owner tokens, wrong owner tokens, and state where the owner id is not `ai-chat`. Recovery is to use the owning token, stop or clean that browser, choose another port, or remove stale AI Chat state.
- Stale state: stale pid, missing process, invalid state file, or unavailable debug port cases go through Browser Tools lifecycle checks. AI Chat can discard its own stale private pointer and start a new owned browser when no live process is present. It must not kill or replace a live browser unless Browser Tools proves it is owned by AI Chat.
- Cleanup: successful requests leave the AI Chat owned browser open and only disconnect from CDP. Cleanup is explicit. It may stop only a Browser Tools browser that passes AI Chat owner-token checks. Use Browser Tools `stop.mjs --clean` with the matching owner token when a fresh profile sync is needed.

The owner token is private runtime state. It may be stored in `~/.cache/pi-browser-tools/ai-chat-browser.json` or `AI_CHAT_BROWSER_STATE_FILE` with local-user permissions so later CLI invocations can reconnect. It must not be printed in normal output, committed, cached with responses, or copied into provider metadata.

## Profile sync and auth recovery

Browser Tools runs Chrome from a copied profile, not the live Chrome profile. AI Chat starts the Browser Tools task profile `ai-chat`, or Chrome profile `Default` when no task profile is configured, so provider accounts should be logged in through that Chrome profile. If the copied profile is stale, stop the AI Chat owned browser with `--clean` and rerun AI Chat so Browser Tools creates a fresh copy.

Provider auth failures should point to profile-sync recovery, not to unsafe attachment to main Chrome. Providers should fail before prompt submission when a session is clearly missing or logged out.

## Conversation and provider state

AI Chat owns the provider-neutral session record lifecycle. A saved local conversation id is scoped by provider and stores enough private continuation state to send only the next user turn when the provider supports backend continuation.

Normal JSON output exposes safe continuation metadata only. If a provider needs a secret continuation token, the local private conversation record can store it, but stdout, stderr, sidecar metadata, and query cache entries must use a redacted form such as `has_read_write_token: true` instead of the token value.

Providers should return both safe state and private continuation state when needed. The AI Chat module decides what is safe for output, cache, evidence, and local private records.

## Provider adapter boundary

AI Chat module owns:

- CLI parsing and provider-neutral flags
- browser startup, reuse, refusal, and cleanup coordination through Browser Tools
- cache keys and cache writes
- local conversation ids and private record storage
- output shape, sidecar artifacts, evidence capture, and final metadata
- fallback policy visibility
- cross-provider test harnesses

Provider adapters own:

- auth preflight and provider-specific recovery messages
- provider endpoint payloads and UI steps
- stream, SSE, WebSocket, network event, or DOM-fallback parsing
- provider model registry, aliases, task defaults, and live verification where supported
- provider-specific request options such as Perplexity source focus, files, Spaces, and streaming
- provider state normalization into safe output state and private continuation state

Browser Tools owns:

- Chrome process launch and stop
- copied profile sync
- owner token safety checks
- managed state validation
- refusal to connect to unmanaged or foreign browsers

## Perplexity parity scope

Perplexity inside AI Chat uses one browser-authenticated network path derived from Browser Tools captures. It has no UI or DOM transport.

In scope:

- headless-preferred Browser Tools startup from the `ai-chat` task profile or fallback Chrome profile `Default`
- same-origin authenticated fetch where browser credentials never leave managed Chrome
- auth recovery guidance aligned with Browser Tools copied-profile behavior
- captured model ids, direct tool aliases, task defaults, Thinking variants, account-tier metadata, and live account acceptance verification
- normal ask and deep research through `/rest/sse/perplexity_ask`, with schematized block-patch streaming and no DOM path
- explicit Incognito and save-to-library behavior, including conflict checks and SSE privacy metadata
- source focus, search focus, time range, citation mode, language, and timezone
- safe file attachments with path validation and metadata that avoids leaking file contents
- Spaces selection by explicit user-provided Space identifier
- streaming progress that still produces the same final structured output contract
- multi-turn continuation using backend UUID plus private read-write token stored only in private local records

Out of scope for this unification pass:

- making AI Chat shell out to another Perplexity CLI for normal requests
- retaining or reintroducing Perplexity rendered HTML parsing, element interaction, or DOM fallback
- committing live model acceptance output or account-specific provider evidence
- supporting Max-tier-only behavior that is not present in the current skill contract
- discovering private Perplexity Space ids without the user providing them

## Tradeoffs

One multi-provider AI Chat skill gives users one command shape, one conversation-store model, one browser owner, and one verification matrix. It reduces repeated browser lifecycle code and makes provider comparison possible.

The cost is that AI Chat becomes the integration point for provider quirks. Provider adapters must stay narrow and well-tested so provider-specific complexity does not leak into the core module.

Provider-specific skills remain useful as references and escape hatches for deeper workflows. They should not become separate orchestration paths for the same AI Chat use cases unless a provider cannot fit the shared browser, session, and output contract.

## Downstream implementation direction

Downstream tasks should implement against this contract without reopening the architecture decision. If a provider cannot meet part of the contract, it should report a documented provider limitation in metadata, tests, and references rather than silently falling back.
