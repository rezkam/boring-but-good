# ADR Format

How to write an Architecture Decision Record that future engineers will actually read and trust. Format conventions, voice rules, anti-patterns to avoid, and when an ADR is worth writing in the first place.

## Default template

```md
# {Short title - noun phrase}

**Status:** accepted

## Context

{Why this came up. The forces - technical, organisational, regulatory - at play, in value-neutral language. State the tensions instead of resolving them yet.}

## Decision

We will {do X}. {Two or three sentences of rationale, in active voice.}

## Consequences

{What follows from the decision - positive, negative, and neutral. All of them, not only the wins.}
```

That's the canonical Nygard shape. Most ADRs need nothing more.

## Single-paragraph variant

If the four-section template feels like padding, collapse to a single paragraph in Olaf Zimmermann's *Y-statement* shape:

```md
# {Title}

In the context of {use case / component}, facing {non-functional requirement
or quality concern}, we decided for {chosen option} and against {leading
alternative}, to achieve {benefit}, accepting {downside}.
```

Useful when the team already shares the context and the trade-off is the only thing worth pinning down.

## Optional sections

Add only when each one carries real weight. Most ADRs need none:

| Section | When to include |
|---|---|
| **Decision drivers** | The actual selection criteria are non-obvious or contested. List 2–4 drivers; don't pretend to score them. |
| **Considered options** | The rejected alternatives are worth remembering - otherwise they re-emerge in six months. One paragraph each, with the rejection reason. |
| **Pros and cons of the options** | Several alternatives all looked plausible. A brief trade-off matrix beats prose here. |
| **Confirmation** | The decision needs validation by something concrete (a benchmark, a load test, a contract test) before it can move from `accepted` to closed-loop. State what proves it works. |
| **More information** | Pointers to PRDs, RFCs, code, external links. |

## Voice and tone

- **Decision section: active voice, "We will…".** Decisions are commitments; passive voice ("X will be used") obscures who chose and why. (Nygard, 2011.)
- **Context section: value-neutral.** State the forces; don't argue for the answer yet. The Context should read the same whether you ended up accepting or rejecting.
- **Whole document: conversational.** Write to a developer joining six months from now. Full sentences. Plain English. Skip the cookbook tone.
- **Consequences: balanced.** If the section has only positives, you wrote a press release. Every decision has trade-offs; if you can't name one, the decision wasn't a real choice and the ADR isn't worth writing.
- **No em dashes.** Hard rule. The U+2014 character (em dash) does not appear in any ADR. Use hyphens with surrounding spaces, commas, sentence breaks, or parentheses instead.
- **No diagrams.** Hard rule. The ADR is the *decision*, not the manual. If a diagram clarifies the design, put it in the architecture spec and reference the section. Diagrams in ADRs trigger the Mega-ADR anti-pattern: they pull in surrounding prose to explain the diagram, the prose pulls in implementation detail, and within a few revisions the ADR is a multi-page document that nobody can scan.

## Length and time budget

A typical ADR takes **10–30 minutes to write, 5 minutes to read, and renders to 1–2 pages**. If yours runs longer, suspect you're explaining how the system works (architecture spec) instead of why a choice was made (decision record). Move that prose elsewhere.

## When to write an ADR

All three of these must be true:

1. **Hard to reverse** - the cost of changing your mind later is meaningful.
2. **Surprising without context** - a future reader will look at the code and wonder "why on earth did they do it this way?"
3. **The result of a real trade-off** - there were genuine alternatives and you picked one for specific reasons.

If a decision is easy to reverse, skip it - you'll just reverse it. If it's not surprising, nobody will wonder why. If there was no real alternative, there's nothing to record beyond "we did the obvious thing."

> The wider community is split on this threshold. Spotify's stance is "almost always - when in doubt, write one." MADR / AWS sit in the middle ("any architecturally significant decision"). We're deliberately on the strict end: the decision dossier this skill produces already records every choice, so the ADR is reserved for the small subset that's genuinely load-bearing.

## Timing: before or during, not after

Write the ADR while the decision is still being made - *before* the implementation lands. ADRs written after implementation tend to read like press releases for the chosen path; they miss the alternatives that actually got debated and the trade-offs that were live in the room. If a decision was already shipped, document it, but mark the status (`accepted, retroactive`), be honest about the alternatives that *were* on the table at the time, and write the Consequences from what you've now learned. (Zimmermann, 2023, calls late-written ADRs the "press release" anti-pattern.)

## File naming

Filenames are load-bearing: future readers find ADRs by scrolling the directory, not by opening each file. Two rules:

1. **Numbered prefix.** Scan the ADR directory (`docs/adr/`, or wherever ADRs live for this project) for the highest existing number and increment by one. Format: `NNNN-` (four digits, leading zeros). The first ADR is `0001-`. Numbering is forever; once `0007-` is taken, it is taken even if `0007` is later superseded.
2. **Clear slug.** The slug after the number must say what was decided, not what was discussed. `0007-uuid-v7-for-service-ids.md` reads well; `0007-id-strategy.md` reads as a topic and forces readers to open the file. Keep slugs concise (3 to 7 words, kebab-case) and scoped to the directory's domain (no need to repeat the service or context name if the ADR lives inside a directory that already implies it).

## Status

Common values:

- `proposed` - open for review; not yet in effect.
- `accepted` - agreed; in effect.
- `rejected` - considered and decided against. Keep the file; record the reason. Otherwise the same proposal returns in six months.
- `deprecated` - no longer applies, but not replaced by a specific successor.
- `superseded by ADR-NNNN` - replaced; link to the successor.

**ADRs are append-only.** Don't edit an accepted ADR. If a decision changes, write a new ADR that supersedes the old one and link both ways: the new ADR cites the old in its Context; the old gets its status flipped to `superseded by ADR-NNNN` with a one-line pointer at the top. The old file stays in the repo. (AWS Prescriptive Guidance, 2022.)

## What qualifies

- **Architectural shape.** "We're using a monorepo." "The write model is event-sourced; the read model is projected into Postgres."
- **Integration patterns between contexts.** "Ordering and Billing communicate via domain events, not synchronous HTTP."
- **Technology choices that carry lock-in.** Database, message bus, auth provider, deployment target. Not every library - just the ones that would take a quarter to swap out.
- **Boundary and scope decisions.** "Customer data is owned by the Customer context; other contexts reference it by ID only." The explicit no-s are as valuable as the yes-s.
- **Deliberate deviations from the obvious path.** "We're using manual SQL instead of an ORM because X." Anything where a reasonable reader would assume the opposite. These stop the next engineer from "fixing" something that was deliberate.
- **Constraints not visible in the code.** "We can't use AWS because of compliance requirements." "Response times must be under 200ms because of the partner API contract."
- **Rejected alternatives when the rejection is non-obvious.** If you considered GraphQL and picked REST for subtle reasons, record it - otherwise someone will suggest GraphQL again in six months.

## What does not qualify

- Library choices that are easily swapped (`luxon` vs `date-fns`, `axios` vs `fetch`).
- Decisions that the framework or platform makes for you.
- Style preferences (tabs vs spaces, quote style, file layout).
- One-off bug fixes - those belong in commit messages, not ADRs.

## Anti-patterns

These are the smells that mark an ADR not worth its file. Adapted from Zimmermann's published catalogue.

| Smell | What it looks like | Fix |
|---|---|---|
| **Fairy tale** | Consequences section lists only benefits. | If you can't name a downside, the decision wasn't a real trade-off. Either add the downside or drop the ADR. |
| **Sales pitch** | Marketing language, superlatives, vague adjectives ("best-in-class," "robust"). | Replace each adjective with a specific behaviour or constraint. Cut what you can't ground. |
| **Dummy alternative** | "Considered options" lists straw-man alternatives nobody actually proposed. | Either include genuine alternatives that were debated, or drop the section. |
| **Sprint** | One option, short-term effects only, no consideration of mid- or long-term consequences. | Explore at least one credible alternative. Name a consequence that lands beyond this quarter. |
| **Tunnel vision** | Local context only - covers what the dev team thinks but ignores ops, security, support, billing. | Add the perspectives the decision actually affects. |
| **Mega-ADR** | Multi-page document with diagrams, code, and a side-quest into the architecture. | Move how-it-works content to the architecture spec. The ADR is the *decision*, not the manual. |
| **Novel** | One ADR covering five separate decisions. | Split. One ADR per decision; cross-link. |
| **Magic tricks** | Weighted scoring matrices that resolve to the answer the author wanted. | If the score is the rationale, the score isn't real. State the rationale in plain English. |
| **Press release** | Written after the implementation landed, framing the chosen path as inevitable. | Either rewrite to surface the alternatives that were live before implementation, or mark `accepted, retroactive` and own the gap honestly. |

## Examples

### Single-paragraph (the common case)

```md
# 0007 - UUID v7 for service-generated IDs

**Status:** accepted

We will generate transaction IDs and idempotency keys with UUID v7
(`uuid-creator`) rather than v4. The embedded millisecond timestamp gives us
chronological ordering for free, which keeps B-tree index locality predictable
in MySQL and makes IDs debuggable. The cost - slight loss of randomness vs v4
- is irrelevant for our use case since IDs are not security tokens.
```

### Y-statement variant (even tighter)

```md
# 0011 - REST over GraphQL for the partner API

**Status:** accepted

In the context of the partner-facing API, facing partner integrators with
varied stacks and a 200ms latency budget, we decided for REST + JSON and
against GraphQL, to achieve maximum tooling ubiquity and predictable per-
endpoint caching, accepting that we lose flexible client-side projection
and have to version more carefully.
```

### With Considered Options and Consequences

```md
# 0012 - Quota balance lives in DBCDR, not the main DB

**Status:** accepted

## Context

`UsageLimitService` enforces quota with an atomic decrement and writes a CDR
in the same transaction. To avoid TOCTOU races, the decrement and the audit
row must be in the same InnoDB transaction. The two existing data sources
are the main application DB and DBCDR (the dedicated CDR database).

## Decision

We will keep `quota_balance` and `usage_cdr` in DBCDR.

## Considered options

- **Both tables in the main DB.** Atomicity holds, but bloats a database that
  already carries the heaviest user-facing load.
- **Tables split across DBs.** Kills the single-transaction guarantee that
  prevents over-deduction.
- **Both in DBCDR.** Chosen.

## Consequences

Limit resolution still reads from the main DB, so the charge flow spans two
data sources. Documented as a known stale-window risk in the architecture
spec; self-corrects on the next charge. We accept that adding new charge-time
state may require new tables in DBCDR rather than the main DB.
```

If you find yourself writing more than that, ask whether the prose belongs in the architecture spec instead.
