# Coordinator hooks

These hooks enforce repository authoring rules during coordinator-owned file, git, and pull request work.

## Install

This hook currently supports the Claude Code `PreToolUse` interface.

For a quick install with `npx skills add`, configure the `PreToolUse` command to use the absolute path to the installed coordinator skill:

```text
$HOME/.claude/skills/coordinator/hooks/guard-output.sh
```

For a manual clone followed by `./setup.sh`, the installed path above is a symlink into the repository. The direct repository path is also valid:

```text
<repository>/skills/coordinator/hooks/guard-output.sh
```

If an existing configuration points to `<repository>/hooks/guard-output.sh`, update it to either path above after pulling this change.

## Test

```bash
bash skills/coordinator/hooks/test-guard-output.sh
```
