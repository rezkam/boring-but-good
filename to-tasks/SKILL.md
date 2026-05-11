---
name: to-tasks
description: Break a plan, spec, or PRD into independently-grabbable tasks using tracer-bullet vertical slices. Ask whether tasks should be created in Jira or written locally, propose the changes first, and only create them after user approval.
---

# To Tasks

Break a plan into independently-grabbable tasks using vertical slices (tracer bullets).

This skill supports two task destinations:

1. **Jira** — create approved tasks in Jira using the `jira` skill.
2. **Local** — write approved tasks into the current repository under `.agents/skills/to-tasks/<current-task>/`.

Always propose the intended task breakdown and destination first, then ask for explicit user approval. Do not create or modify Jira tasks or local task files before approval.

## Process

### 1. Gather context

Work from whatever is already in the conversation context. If the user passes a Jira key or Jira URL, use the `jira` skill to fetch it and read its full body and comments. If the user passes a path, read it as source material for the task breakdown.

If the target destination is not clear, ask the user to choose:

- **Jira** — create tasks in Jira after approval.
- **Local** — create task files in the current repo after approval.

For Jira, ask for any missing Jira project key, task type, or required labels before proposing task creation.

### 2. Explore the codebase (optional)

If you have not already explored the codebase, do so to understand the current state of the code. Task titles and descriptions should use the project's domain glossary vocabulary, and respect ADRs in the area you're touching.

### 3. Draft vertical slices

Break the plan into **tracer bullet** tasks. Each task is a thin vertical slice that cuts through ALL integration layers end-to-end, NOT a horizontal slice of one layer.

Tasks may be 'HITL' or 'AFK'. HITL tasks require human interaction, such as an architectural decision or a design review. AFK tasks can be implemented and merged without human interaction. Prefer AFK over HITL where possible.

<vertical-slice-rules>
- Each task delivers a narrow but COMPLETE path through every layer (schema, API, UI, tests)
- A completed task is demoable or verifiable on its own
- Prefer many thin tasks over few thick ones
</vertical-slice-rules>

### 4. Quiz the user

Present the proposed breakdown as a numbered list of tasks and the exact changes you intend to make. No Jira tasks or local task files should be created or modified yet. For each task, show:

- **Title**: short descriptive name
- **Destination**: Jira / Local
- **Type**: HITL / AFK
- **Blocked by**: which other tasks (if any) must complete first
- **User stories covered**: which user stories this addresses (if the source material has them)

Ask the user:

- Does the granularity feel right? (too coarse / too fine)
- Are the dependency relationships correct?
- Should any tasks be merged or split further?
- Are the correct tasks marked as HITL and AFK?
- Do you approve creating these tasks in the selected destination now?

Iterate until the user explicitly approves the breakdown, the destination, and the specific changes. Do not create, update, label, assign, comment on, transition, close, or otherwise modify Jira tasks before approval. Do not create, update, or delete local task files before approval.

### 5A. Create approved Jira tasks

Only after explicit approval, use the `jira` skill to perform the approved Jira changes. First load/use the `jira` skill instructions and check Jira metadata for the target project (task types, fields, priorities, and available statuses/transitions) before creating anything.

For each approved task, create a new Jira task using the task body template below. Prefer the project team's normal Story/Task type for planned work unless the user or Jira metadata indicates another type. Create tasks in dependency order (blockers first) so you can reference real Jira keys in the "Blocked by" field.

After creating them, navigate Jira through the `jira` skill as needed. Viewing created tasks is allowed for verification; any further mutating action such as adding comments, applying labels, assigning, or transitioning must either be part of the approved change list or require a new approval. Return the created Jira keys/URLs and a concise dependency map to the user.

### 5B. Create approved local tasks

Only after explicit approval, create local task files in the current repository.

Local destination:

```text
.agents/skills/to-tasks/<current-task>/
```

Use a short kebab-case directory name for `<current-task>` based on the parent plan or task theme. Inside that directory, create one Markdown file per approved task, prefixed with its dependency order, for example:

```text
.agents/skills/to-tasks/<current-task>/
001-task-title.md
002-next-task.md
```

Each local task file must use the task body template below. Return the created file paths and a concise dependency map to the user.

<task-template>
## Parent

A reference to the parent Jira task, source document, plan, or conversation context if one exists. Otherwise omit this section.

## What to build

A concise description of this vertical slice. Describe the end-to-end behavior and outcome, not layer-by-layer implementation or a proposed code solution.

Avoid specific file paths, code snippets, or fix instructions — they go stale fast and belong in implementation work, not the task. Exception: if a prototype produced a snippet that encodes a decision more precisely than prose can (state machine, reducer, schema, type shape), inline it here and note briefly that it came from a prototype. Trim to the decision-rich parts — not a working demo, just the important bits.

## Acceptance criteria

- [ ] Criterion 1
- [ ] Criterion 2
- [ ] Criterion 3

## Blocked by

- A reference to the blocking Jira key or local task file (if any)

Or "None - can start immediately" if no blockers.

</task-template>

Do NOT close or modify any parent Jira task unless the user explicitly asks for that action.
