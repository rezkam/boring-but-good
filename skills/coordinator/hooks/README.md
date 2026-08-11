# Coordinator hooks

These hooks enforce repository authoring rules during coordinator-owned file, git, and pull request work.

## Install

Configure the `PreToolUse` command to use the absolute path to:

```text
<repository>/skills/coordinator/hooks/guard-output.sh
```

If an existing configuration points to `<repository>/hooks/guard-output.sh`, update it to the path above after pulling this change.

## Test

```bash
bash skills/coordinator/hooks/test-guard-output.sh
```
