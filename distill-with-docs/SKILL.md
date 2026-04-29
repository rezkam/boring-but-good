---
name: distill-with-docs
description: Distill scattered meeting notes, chat transcripts, and a PRD into one decision dossier - clearly stating the problem, the alternatives, the decisions reached, and the feasibility of each. Updates CONTEXT.md and creates ADRs inline as decisions crystallise. Use after a planning round when raw discussion material needs to land in a structured, durable document.
disable-model-invocation: true
---

# distill-with-docs

You have raw input - meeting notes, chat transcripts, possibly a PRD - and a codebase with documented context (`CONTEXT.md`, `docs/adr/`). Your job is to **distill** that input into one coherent **decision dossier**: a single file that tells a future reader the problem, the solutions considered, the decisions reached, and the feasibility of each.

You are not summarising. You are forming a structured artifact that someone joining the project six months from now should be able to read without going back to the original chats.

## House style

- **No em dashes.** This is a hard rule for everything this skill writes: the dossier, any ADRs, any updates to `CONTEXT.md`. The U+2014 character (em dash) does not appear in any output. Use hyphens with surrounding spaces ` - `, commas, sentence breaks, or parentheses instead. If existing in-repo docs already use em dashes, do not introduce new ones; leave the old ones unless asked to clean up.
- **Plain English over jargon.** If a sentence reads like an analyst's deck ("leverage", "best-in-class", "robust"), rewrite it.
- **Active voice.** "We will X" beats "X will be done."

## Inputs

The user will provide some combination of:

- **Meeting notes / chat transcripts** - pasted into the conversation, attached as files, or pointed at in Slack/Notion/Linear.
- **A PRD or product brief** - typically a Google Doc, GitHub issue, or markdown file in the repo.
- **Existing project documentation** - `CONTEXT.md`, `CONTEXT-MAP.md`, `docs/adr/` already in the repo.
- **The codebase itself** - when it agrees or disagrees with what the discussions claim is happening.

If the user gives you a thin set of inputs, ask once for what's missing. Do not invent.

## Process

1. **Read everything.** Including the existing docs in the repo (`CONTEXT.md`, the latest few ADRs in `docs/adr/`). Cross-reference the discussion against what's already documented. Note any contradictions explicitly - don't paper over them.
2. **Extract the threads.** Group the raw input into:
   - **Problem(s) being solved** - what triggered the discussion?
   - **Solutions considered** - including the ones that were rejected and why.
   - **Decisions reached** - explicit and implicit.
   - **Open questions** - things that surfaced but weren't resolved.
3. **Assess feasibility.** For each decision, what would it actually take to ship? Where does the codebase agree (the change is small) and where does it disagree (the discussion assumes something the code doesn't support)? Cite specific file paths or modules when calling out feasibility risks.
4. **Sharpen the language.** When the discussion uses fuzzy or overloaded terms, propose a precise canonical term. Cross-reference against `CONTEXT.md`. If the discussion conflicts with documented language, call it out in the dossier *and* update `CONTEXT.md` - see [CONTEXT-FORMAT.md](./CONTEXT-FORMAT.md).
5. **Offer ADRs sparingly.** Only when the criteria in [ADR-FORMAT.md](./ADR-FORMAT.md) are met (hard to reverse + surprising + real trade-off). One ADR per genuinely load-bearing decision; not one per bullet point.
6. **Produce the dossier.** A single markdown file with the structure below. Hand it back to the user; let them push it through their normal review.

## Output: the decision dossier

Write it to `docs/decisions/<short-slug>.md` (create the directory lazily). Use this structure - keep sections tight; only include what carries weight.

```md
# {Topic - short and concrete}

| | |
|---|---|
| **Status** | Draft / Reviewed / Accepted |
| **Author** | {name from git config} |
| **Date** | {today, ISO} |
| **Sources** | {meetings / chats / PRDs that fed this} |

## Problem

What's wrong, or what changed, that triggered this discussion. Concrete enough that a reader who wasn't in the room can understand the stakes. One paragraph; cite affected systems / users / numbers.

## Solutions considered

Brief description of each alternative that was on the table, including the rejected ones. One paragraph each. **Name the rejected ones explicitly** - otherwise they re-emerge in six months.

## Decisions

The decisions that were actually made. State each as a sentence, then a short paragraph of reasoning. Distinguish:

- **Decided** - the team agreed.
- **Recommended** - author's recommendation pending sign-off.

If a decision matches the ADR criteria, link to the new ADR file you created.

## Feasibility

For each decision, what does it cost to ship? Concrete file paths, modules, dependencies, or external systems. Flag the parts where the discussion's assumptions diverge from the code.

## Open questions

What remains unresolved, what the next decision-point looks like, and who needs to answer.

## Affected documentation

- `CONTEXT.md` - terms added or sharpened (with the resolved canonical names).
- `docs/adr/NNNN-...` - new ADRs created for load-bearing decisions.
- Pointers to PRDs, design docs, or external links that were consulted.
```

If a section has nothing of value, drop it. A two-paragraph dossier with Problem + Decisions is more useful than a long one full of filler.

### Diagrams in the dossier

Embed a Mermaid diagram inline whenever the discussion involves a non-trivial flow, state machine, or data model that's hard to follow as prose. Skip diagrams that just retell the text. Format guidance - diagram type to choose, theme-safe styling, GitHub render quirks, verification steps - is in [GRAPH-FORMAT.md](./GRAPH-FORMAT.md). That file is intentionally self-contained so other skills can link to it.

## Domain awareness

### File structure

Most repos have a single context:

```
/
├── CONTEXT.md
├── docs/
│   ├── adr/
│   │   ├── 0001-event-sourced-orders.md
│   │   └── 0002-postgres-for-write-model.md
│   └── decisions/
│       └── {slug}.md         ← this skill writes here
└── src/
```

If a `CONTEXT-MAP.md` exists at the root, the repo has multiple contexts. Each one has its own `CONTEXT.md` and its own `docs/adr/`. The dossier still lives at the root `docs/decisions/` unless the discussion is clearly scoped to one context - then write inside that context's directory.

Create files lazily - only when you have something to write.

### CONTEXT.md

When the discussion uses a term that conflicts with existing language in `CONTEXT.md`, call it out in the dossier *and* update `CONTEXT.md` inline. Don't batch - capture as you go.

When the discussion introduces a new domain term that's clearly load-bearing (multiple speakers used it, it sharpens a previously fuzzy idea), add it. Skip implementation-detail terms - they belong in code comments, not the glossary.

Use the format in [CONTEXT-FORMAT.md](./CONTEXT-FORMAT.md).

### ADRs

Offer to create an ADR only when all three are true:

1. **Hard to reverse** - the cost of changing your mind later is meaningful.
2. **Surprising without context** - a future reader will wonder "why did they do it this way?"
3. **The result of a real trade-off** - there were genuine alternatives and you picked one for specific reasons.

If any of the three is missing, skip it. The dossier itself records the decision; the ADR is for the small subset worth pinning down with permanent numbering.

Use the format in [ADR-FORMAT.md](./ADR-FORMAT.md).

## Anti-patterns

- **Don't paste verbatim.** A good dossier compresses the discussion. If a sentence in your output reads like a chat message, rewrite it.
- **Don't decide things the team didn't.** If the discussion left a question open, mark it Open. Don't synthesise a fake consensus.
- **Don't pad sections.** If "Solutions considered" has only one option, write one paragraph and stop. Filler erodes trust in the document.
- **Don't dodge contradictions.** When the discussion conflicts with the code or existing docs, surface it. That's the highest-value thing this skill produces.
- **Don't write ADRs for things that aren't decisions.** "We use logging" is not an ADR. "We send domain events instead of synchronous HTTP between Ordering and Billing" is.
