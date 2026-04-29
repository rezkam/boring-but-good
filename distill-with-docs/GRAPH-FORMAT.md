# Graph Format

How to write diagrams that render correctly on GitHub and stay readable inside decision dossiers, ADRs, and context docs.

## Why Mermaid

GitHub natively renders Mermaid inside fenced \`\`\`mermaid blocks in any `.md` file (since 2022). No external tools, no image checked into git, edits show up in PR diffs as text. Default to Mermaid for any diagram in this skill's outputs unless the diagram genuinely cannot be expressed as Mermaid (e.g. an infrastructure photo).

## Choosing the diagram type

| Type | Mermaid keyword | When to use |
|---|---|---|
| Flowchart | `flowchart TD` or `flowchart LR` | Process flow, decision tree, control flow where time isn't the primary axis. |
| Sequence | `sequenceDiagram` | Interaction between named actors over time - *who does what when*. |
| State machine | `stateDiagram-v2` | Finite-state model - explicit states and transitions. |
| Entity-Relationship | `erDiagram` | Data model - tables, columns, relationships. |
| Class | `classDiagram` | Type hierarchy or component structure. |

Rule of thumb: if "who does what when" matters, use a sequence diagram. Otherwise a flowchart.

## Format rules

### Keep it small

- **5–12 nodes per diagram.** Past that, comprehension drops and rendering on mobile becomes noisy.
- If a topic genuinely needs more, split into two diagrams that share node names - not one mega-diagram.
- Node labels: 2–6 words. Use `<br/>` to break long labels into lines.

### Theme-safe styling

GitHub renders with light *or* dark theme based on the reader's setting. Never hardcode colors that fail on one.

- **Default theme first.** Skip `classDef` entirely if you don't need to highlight anything.
- **When highlighting matters**, use these theme-safe palettes:
  - Error / negative path: `fill:#7a1c1c, color:#ffcccc, stroke:#ff5555`
  - Success / positive path: `fill:#0d3320, color:#b3ffd1, stroke:#50fa7b`
  - Cached / informational path: `fill:#0d2233, color:#b3e8ff, stroke:#8be9fd`
  - Neutral container: leave default
- **Don't use** pure white backgrounds (vanish on light theme), pure black (clash on dark), neon yellow, or gradients.
- **Pair colour with shape or label.** Colour alone fails for colour-blind readers and print views.

### Direction

- Flowcharts: prefer `TD` (top-down) - reads like text. Switch to `LR` only when the chain is 4+ horizontal steps and `TD` would scroll off-screen.
- Sequence: actors at top, time flows downward - Mermaid handles this for you.

### Labels and quoting

- Wrap any label containing a space, parenthesis, slash, colon, or quote in `"..."`. Cheaper to quote everything than debug parse errors.
- Edge labels (`|"label"|`) should be ≤ 4 words. Longer ones overlap.
- Don't include `:` in unquoted node IDs - Mermaid parses it as a token.

### Subgraphs

- Group related steps with `subgraph "Group name"` (always quote the title). Default border is faint - don't fight it with `classDef`.
- Don't nest subgraphs more than one level deep.

## Templates

### Flowchart with success / error styling

\`\`\`mermaid
flowchart TD
    START["Start"]
    START --> CHECK{"Validation"}
    CHECK -->|"ok"| WORK["Process"]
    CHECK -->|"fail"| ERR(["Reject"])
    WORK --> DONE(["Accept"])

    classDef error   fill:#7a1c1c,color:#ffcccc,stroke:#ff5555
    classDef success fill:#0d3320,color:#b3ffd1,stroke:#50fa7b
    class ERR error
    class DONE success
\`\`\`

### Sequence diagram

\`\`\`mermaid
sequenceDiagram
    participant App as Mobile App
    participant API as API Handler
    participant SVC as Service

    App->>API: Request
    API->>SVC: Forward
    SVC-->>API: Response
    API-->>App: Response
    Note over App: Display result
\`\`\`

### Entity-Relationship

\`\`\`mermaid
erDiagram
    ORDER {
        int id PK
        int customer_id FK
        date placed_at
    }
    CUSTOMER {
        int id PK
        varchar name
    }
    ORDER }o--|| CUSTOMER : "placed by"
\`\`\`

### State machine

\`\`\`mermaid
stateDiagram-v2
    [*] --> Pending
    Pending --> Approved: review ok
    Pending --> Rejected: review fail
    Approved --> [*]
    Rejected --> [*]
\`\`\`

## Verifying it renders on GitHub

Mermaid renders client-side in GitHub's web UI. The fastest verification flow:

1. **Live editor first.** Paste the diagram into [mermaid.live](https://mermaid.live/) before committing. Catches syntax errors instantly with a useful error message.
2. **GitHub preview.** Push the branch and open the file on GitHub. GitHub's Mermaid version may lag the live editor - if mermaid.live renders cleanly but GitHub doesn't, the diagram is using too-new syntax.
3. **PR diff view.** GitHub also renders Mermaid in PR diffs. Worth a glance - the diff context can reveal labels that overlap or a node that runs off the right edge.

If a GitHub render fails silently (block shows the raw text instead of a diagram):

- Check the browser console for parse errors.
- Reduce to half the nodes and re-test - diagrams above ~30 nodes can silently exceed Mermaid's defaults.
- Look for syntax that the live editor accepted but GitHub doesn't (e.g. very new flag in `stateDiagram-v2`).

## Common breakage

- **Special characters in labels.** Wrap in `"..."` - quotes, parentheses, slashes, colons inside unquoted labels cause parse errors.
- **`graph` vs `flowchart`.** Both work; `flowchart` is the modern keyword and supports more features. Use `flowchart`.
- **Inline HTML.** Mermaid honours `<br/>` and not much else. Skip `<a>`, `<img>`, `<span>`, etc. inside node labels.
- **Mixed direction.** Don't put `direction TB` inside a flowchart that already declared `flowchart LR` - Mermaid silently falls back.
- **Trailing whitespace inside the fenced block** sometimes breaks detection. Keep \`\`\`mermaid on its own line, with the diagram on the next line.
- **Subgraph titles with unquoted spaces** break the parser. Always quote: `subgraph "Charge Transaction"`.

## Anti-patterns

- **Diagrams that duplicate prose.** If the text already lists "step 1, step 2, step 3", a flowchart of the same is noise. Diagram only when the visual structure is the point.
- **One mega-diagram.** Past ~12 nodes, comprehension drops. Split into two named diagrams.
- **Hand-drawn or external images** for things Mermaid can express. Slows review (binary blob), uneditable, doesn't diff. Use Mermaid unless impossible.
- **Colour as the only signal.** Always pair with shape, label, or position so the diagram still works in greyscale.
- **Skipping verification.** Mermaid fails silently on unsupported syntax in some GitHub views. Always preview before committing.
