# The bite-check

Proof that a test measures the behavior it claims to measure. Run it once per new or changed
test, at green.

Except when you already have the proof: if you watched the test fail before the code existed and
the failure was the assertion you intended, that is the same evidence obtained earlier and the
procedure below is redundant. A test authored after the code has no such history and always
gets a bite-check.

## Procedure

1. Pick the single line or block that implements the behavior under test.
2. Remove or invert it with your editing tool. One change, minimal, surgical.
3. Run only the affected test file. Expect red, and expect the red to be your assertion, not a
   type error, an import failure, or a crash. A crash proves the code path runs; it does not
   prove the assertion discriminates.
4. Undo the edit with the same editing tool.
5. Re-run. Expect the original green.
6. Record the flipped assertion verbatim in the slice report.

## Never use git to undo the bite

`git checkout -- <file>`, `git restore <file>`, and `git stash` all restore the whole file from
HEAD. On a worktree holding uncommitted slice work, that silently deletes it. This has happened
twice, once losing a full slice across two files that had to be reconstructed from diffs
captured earlier in the conversation.

Two safe options:

- Undo the bite with the editor, exactly reversing the edit you made.
- Commit the slice first, then bite-check. `git checkout` is now safe because the work is in
  the commit, but the editor route still costs less.

Before biting a file, know whether it holds uncommitted work. If you are not sure, commit.

## When the bite cannot fail

The test is hollow. Do not accept it. Strengthen the assertion until removing the behavior
breaks it, then bite again. See [hollow-tests.md](hollow-tests.md) for the shapes this takes.

If you cannot construct a bite after a genuine attempt, the test is not measuring anything and
should be deleted or replaced, not kept as decoration.

## When a bite is not applicable

Prose, docs, config, and pure deletions have nothing to invert. Some guards cannot be written
without false positives, for example a grep guard over docs that would fire on the document
explaining the removal it guards against.

Declare it: `TEST-EXEMPT: <reason>`. Verify the claim firsthand before accepting it from a
subagent; one such exemption was correct, and accepting it without checking would have been
luck rather than judgment.

## Reading a subagent's bite claim

A report saying "verified, test bites" is a claim. The worktree and your own run are the
evidence. Re-run the bite yourself when the behavior is load-bearing: a fail-closed gate, a
security or safety check, a guard against a bug that already shipped once.
