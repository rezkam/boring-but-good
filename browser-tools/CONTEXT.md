# Browser Tools Context

Browser Tools is a skill for controlling a sandboxed Chrome browser and extracting generic page content when low-level browser control is not enough.

## Language

**Skill Interface**:
The instruction surface an agent reads to know what capabilities the skill offers.
_Avoid_: flat tool list

**Browser Control**:
The core capability set for launching, stopping, navigating, evaluating, screenshotting, and selecting inside the sandboxed browser.
_Avoid_: base thing, main capabilities

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
