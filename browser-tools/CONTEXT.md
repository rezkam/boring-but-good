# Browser Tools Context

Browser Tools is a skill for controlling a sandboxed Chrome browser and using task-specific helpers when low-level browser control is not enough.

## Language

**Skill Interface**:
The instruction surface an agent reads to know what capabilities the skill offers.
_Avoid_: flat tool list

**Browser Control**:
The core capability set for launching, stopping, navigating, evaluating, screenshotting, and selecting inside the sandboxed browser.
_Avoid_: base thing, main capabilities

**Resource Helper**:
A task-specific helper script that uses **Browser Control** to access one external resource or workflow.
_Avoid_: handler, scraper, finance tool

**Resource Helper Module**:
The shared implementation module that owns Resource Helper lifecycle details such as cache flow, browser connection, output sidecars, page cleanup, and browser disconnect.
_Avoid_: helper base class, utility grab bag

**Trading Economics Module**:
The shared internal module for Trading Economics Resource Helpers. It owns page overlay removal, table payload extraction, text cleanup, markdown table formatting, URL slug helpers, and common metadata shape.
_Avoid_: scraper utilities, copy-pasted page code

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

- The **Skill Interface** presents **Browser Control** before **Resource Helpers**.
- A **Resource Helper** uses the **Resource Helper Module** for repeated lifecycle behavior.
- Trading Economics **Resource Helpers** use the **Trading Economics Module** for repeated Trading Economics page behavior.
- The **Resource Helper Module** uses **Browser Control** rather than owning browser lifecycle safety.
- **Browser Control** owns **Profile Sync**.
- A **Managed Browser** is the only browser process **Browser Control** is allowed to stop, and only when the caller provides the matching **Owner Token**.

## Example dialogue

> **Dev:** "Should Yahoo price extraction be listed beside `scripts/start.mjs` and `scripts/nav.mjs`?"
> **Domain expert:** "No. Yahoo price extraction is a **Resource Helper**. The main capability is **Browser Control**."

## Flagged ambiguities

- "handler" was used for both browser actions and task-specific scripts. Resolved: browser actions belong to **Browser Control**, task-specific scripts are **Resource Helpers**.
- "scale" was used to mean **Skill Interface** in this context.
