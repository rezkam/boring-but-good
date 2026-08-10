# Phase 6 — Verification & Summary

## 6.1 Full clean build

```bash
mvn clean verify    # Maven (compile + test + integration + package)
```

## 6.2 Static analysis

```bash
jdeprscan --release 25 -l --for-removal target/*.jar 2>/dev/null
jdeps -jdkinternals target/classes 2>/dev/null
```

## 6.3 Review warnings

- **Deprecation warnings**: Note new `@Deprecated(forRemoval=true)` from JDK 25
- **`sun.misc.Unsafe` warnings**: Expected from Maven/Guice/Spring — framework responsibility
- **Native access warnings**: Note if `--enable-native-access` needed
- **Annotation processing**: Ensure processors run correctly

## 6.4 Produce summary

Report must include:

1. **Files changed** — every modified file with one-line description
2. **Build & infrastructure** — version bumps, Docker images, CI configs
3. **Breaking changes fixed** — what was found, how resolved
4. **Language features adopted** — which JEPs, where, why
5. **Dependencies updated** — version changes with reasons
6. **Test results** — total, passed, failed, skipped
7. **Performance comparison** — if measured
8. **Remaining warnings** — for future attention
9. **Manual action items** — anything requiring human review

**Cross-reference the MASTER CHECKLIST one final time** — verify every applicable item is addressed, noted, or explicitly marked as not-applicable.
