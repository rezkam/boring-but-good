# Browser Tools Context

Browser Tools is a skill for controlling a sandboxed Chrome browser and extracting generic page content when low-level browser control is not enough.

## Language

**Skill Interface**:
The instruction surface an agent reads to know what capabilities the skill offers.
_Avoid_: flat tool list

**Browser Control**:
The core capability set for launching, stopping, navigating, evaluating, screenshotting, and selecting inside the sandboxed browser.
_Avoid_: base thing, main capabilities

**Visual Recording**:
An owner-protected GIF capture of one active browser tab, with pre-action and post-action frames around a multi-step interaction so a user can inspect the flow later.
_Avoid_: video capture, anonymous recording

**Visual Review Artifact**:
A sampled contact-sheet PNG plus machine-readable GIF metadata used to verify that a **Visual Recording** clearly shows its initial, action, and final states.
_Avoid_: screenshot dump, video thumbnail

**Network Capture**:
An owner-protected HAR 1.2 recording of selected active-tab HTTP traffic, including bounded request and response evidence needed to understand a browser interaction.
_Avoid_: packet dump, replay script

**Network Recipe**:
A compact chronological extraction from a **Network Capture** that an agent can inspect before authoring a separate replay script.
_Avoid_: executable replay, generated API client

**Raw CDP Capture**:
A private JSONL stream of selected Chrome DevTools Protocol events for cases where HAR cannot represent the needed protocol detail.
_Avoid_: HAR, browser log

**CDP Call**:
A single owner-protected protocol method sent to the active managed tab, with known lifecycle-bypass methods blocked.
_Avoid_: unmanaged DevTools connection, browser shutdown

**Generic Extractor**:
A task-neutral helper script that uses **Browser Control** to extract current-page links or article text.
_Avoid_: domain scraper, finance tool

**Extractor Module**:
The shared implementation module that owns extractor lifecycle details such as cache flow, browser connection, output sidecars, page cleanup, and browser disconnect.
_Avoid_: helper base class, utility grab bag

**Profile Sync**:
The copied Chrome profile data used by **Browser Control** to reuse authenticated sessions without touching the main Chrome profile. It is a snapshot, so it can be stale until refreshed with `--sync`.
_Avoid_: live profile

**Managed Browser**:
A sandboxed Chrome process launched by **Browser Control** and recorded with managed state and an owner token so it can be used and stopped safely by one agent.
_Avoid_: main Chrome, reused browser

**Owner Token**:
The per-agent secret printed by **Browser Control** at start and required for later connect and stop commands.
_Avoid_: port, profile name, managed token

## Relationships

- The **Skill Interface** presents **Browser Control** first.
- **Visual Recording** uses **Browser Control** ownership and active-tab selection, and keeps its own bounded recording lifecycle.
- A **Visual Review Artifact** is generated after **Visual Recording** and does not reconnect to the browser.
- A **Network Capture**, **Raw CDP Capture**, and **CDP Call** all require **Browser Control** ownership before connecting to the active tab.
- A **Network Capture**, **Network Recipe**, **Raw CDP Capture**, and **CDP Call** preserve exact debugging evidence by default. Redaction is an explicit output option, not the default.
- A **Network Recipe** is derived from a **Network Capture** and never executes requests.
- A **Generic Extractor** uses the **Extractor Module** for repeated lifecycle behavior.
- Specialist skills, such as finance, should call Browser Tools instead of adding domain helpers here.
- The **Extractor Module** uses **Browser Control** rather than owning browser lifecycle safety.
- **Browser Control** owns **Profile Sync**.
- A **Managed Browser** is the only browser process **Browser Control** is allowed to stop, and only when the caller provides the matching **Owner Token**.

## Example dialogue

> **Dev:** "Should stock price extraction be listed beside `scripts/start.mjs` and `scripts/nav.mjs`?"
> **Domain expert:** "No. Stock price extraction belongs in the finance skill. Browser Tools owns **Browser Control**."

## Flagged ambiguities

- "resource helper" was used for both generic page extraction and domain-specific workflows. Resolved: Browser Tools keeps generic extractors only. Domain workflows live in specialist skills.
