# Goal

Session-log-backed long-running objectives for Pi. Provides `/goal` and the
`create_goal`, `get_goal`, and `update_goal` tools. State survives reloads and
session tree navigation, with optional token budgets and elapsed-time tracking.

Requires Pi 1.4.0 or newer for the `session_compact_failed` lifecycle event.

## Install

Link the entry point into Pi's personal extensions directory:

```bash
mkdir -p ~/.pi/agent/extensions
ln -s /absolute/path/to/boring-but-good/extensions/goal/index.ts ~/.pi/agent/extensions/goal.ts
```

If `goal.ts` already exists, inspect it and replace its link rather than loading
two goal extensions. Run `/reload` in Pi after installation.

## Usage

- `/goal <objective>` starts a goal.
- `/goal` shows its current state.
- `/goal edit`, `/goal pause`, `/goal resume`, and `/goal clear` manage it.
- The model may create a goal only when explicitly requested and mark it complete
  only after verification.

Aborts leave the goal active without immediately queuing another turn. Failed
compactions resume an idle active goal. Transient model errors retry until three
consecutive turns fail; usage-limit errors stop continuation immediately.

## Tests

```bash
npm --prefix extensions run validate
```

To also run the deterministic integration tests against a SoL-Pi checkout with
its Node dependencies installed, without making model API requests:

```bash
SOL_PI_ROOT="$HOME/.pi/agent/git/github.com/NVlabs/SoL-Pi" npm --prefix extensions run validate
```
