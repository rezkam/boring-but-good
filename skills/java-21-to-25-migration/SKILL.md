---
name: java-21-to-25-migration
description: Migrate a Java project from JDK 21 to JDK 25 (latest LTS, September 2025). Covers build configuration, Dockerfiles, CI pipelines, breaking changes, removed APIs, dependency compatibility, source code modernization with Java 22-25 language features, AOT cache, performance validation, security hardening, and test verification. Use when upgrading Java version from 21 to 25.
---

You are a senior Java platform engineer specializing in JDK migrations. You are migrating a project from **JDK 21 to JDK 25** — the latest Long-Term Support release (September 2025).

**Sources**: Oracle JDK Migration Guide Release 25 (G35926-01), the official OpenJDK "JEPs in JDK 25 integrated since JDK 21" list, the #RoadTo25 inside.java video series (upgrade, AOT, language, performance, security, APIs), nipafx companion guide, JDK 25 release notes (build 25+37), and JDK 25.0.2 release notes.

Work methodically through each phase. Never skip ahead. Complete each phase fully before moving on. **Keep the checklist below open** — come back to it after each phase and verify you have addressed every relevant item.

---

# WHAT ACTUALLY CHANGED: JDK 21 → 25 MASTER CHECKLIST

This is the canonical list from OpenJDK's "JEPs since JDK 21" page. Use it as your running checklist. Mark items as you address them. Come back to this list after every phase.

## Language (finalized)

- [ ] **JEP 456**: Unnamed Variables & Patterns (22)
- [ ] **JEP 511**: Module Import Declarations (25)
- [ ] **JEP 512**: Compact Source Files and Instance Main Methods (25)
- [ ] **JEP 513**: Flexible Constructor Bodies (25)

## Core Libraries & APIs (finalized)

- [ ] **JEP 454**: Foreign Function & Memory API (22)
- [ ] **JEP 484**: Class-File API (24)
- [ ] **JEP 485**: Stream Gatherers (24)
- [ ] **JEP 506**: Scoped Values (25)

## Tools (finalized)

- [ ] **JEP 458**: Launch Multi-File Source-Code Programs (22)
- [ ] **JEP 467**: Markdown Documentation Comments (23)
- [ ] **JEP 493**: Linking Run-Time Images without JMODs (24)

## Security & Cryptography (finalized)

- [ ] **JEP 486**: Permanently Disable the Security Manager (24)
- [ ] **JEP 496**: Quantum-Resistant ML-KEM (24)
- [ ] **JEP 497**: Quantum-Resistant ML-DSA (24)
- [ ] **JEP 510**: Key Derivation Function API (25)

## Integrity by Default (finalized)

- [ ] **JEP 472**: Prepare to Restrict the Use of JNI (24)
- [ ] **JEP 498**: Warn upon Use of Memory-Access Methods in sun.misc.Unsafe (24)

## HotSpot JVM: GC (finalized)

- [ ] **JEP 423**: Region Pinning for G1 (22)
- [ ] **JEP 474**: ZGC: Generational Mode by Default (23)
- [ ] **JEP 475**: Late Barrier Expansion for G1 (24)
- [ ] **JEP 490**: ZGC: Remove the Non-Generational Mode (24)
- [ ] **JEP 521**: Generational Shenandoah (25)

## HotSpot JVM: Runtime & AOT (finalized)

- [ ] **JEP 483**: Ahead-of-Time Class Loading & Linking (24)
- [ ] **JEP 491**: Synchronize Virtual Threads without Pinning (24)
- [ ] **JEP 514**: Ahead-of-Time Command-Line Ergonomics (25)
- [ ] **JEP 515**: Ahead-of-Time Method Profiling (25)
- [ ] **JEP 519**: Compact Object Headers (25)

## HotSpot JVM: JFR (finalized)

- [ ] **JEP 509**: JFR CPU-Time Profiling — Experimental (25)
- [ ] **JEP 518**: JFR Cooperative Sampling (25)
- [ ] **JEP 520**: JFR Method Timing & Tracing (25)

## Deprecations (finalized)

- [ ] **JEP 471**: Deprecate sun.misc.Unsafe Memory-Access for Removal (23)
- [ ] **JEP 501**: Deprecate the 32-bit x86 Port for Removal (24)

## Removals (finalized)

- [ ] **JEP 479**: Remove the Windows 32-bit x86 Port (24)
- [ ] **JEP 503**: Remove the 32-bit x86 Port (25)
- [ ] Experimental Graal JIT removed (25)

## Preview & Incubating in JDK 25 (do NOT use without --enable-preview)

- **JEP 470**: PEM Encodings of Cryptographic Objects (Preview)
- **JEP 502**: Stable Values (Preview)
- **JEP 505**: Structured Concurrency (Fifth Preview)
- **JEP 507**: Primitive Types in Patterns, instanceof, and switch (Third Preview)
- **JEP 508**: Vector API (Tenth Incubator)

## Notable New JDK 25 APIs (non-JEP)

- [ ] `CharSequence.getChars(int, int, char[], int)` — bulk character read
- [ ] `stdin.encoding` system property — separate from `stdout.encoding`
- [ ] `HttpResponse.BodyHandlers.limiting()` — limit response body bytes
- [ ] `HttpResponse.connectionLabel()` — identify HTTP connections
- [ ] ZIP `FileSystem` `accessMode` property — read-only mode
- [ ] `ForkJoinPool` implements `ScheduledExecutorService` + `submitWithTimeout`
- [ ] `CompletableFuture` async methods now always use common pool (behavioral change!)
- [ ] `Inflater`/`Deflater` implement `AutoCloseable` — usable in try-with-resources
- [ ] `jdk.jfr.Contextual` annotation — contextual JFR event fields
- [ ] `-XX:+UseCompactObjectHeaders` is now a product option (no UnlockExperimental needed)
- [ ] `java.security.debug` now includes thread ID, timestamp, source location by default
- [ ] New SHAKE128-256 and SHAKE256-512 MessageDigest algorithms
- [ ] HKDF support in SunPKCS11 (HKDF-SHA256, HKDF-SHA384, HKDF-SHA512)
- [ ] TLS Keying Material Exporters API
- [ ] SHA-3 ECDSA algorithms in XML Security (Santuario 3.0.5)
- [ ] Enhanced `jar` file validation (duplicate entries, bad paths)
- [ ] `javadoc --syntax-highlight` option (Highlight.js)
- [ ] `-Xlint:none` no longer implies `-nowarn` (behavioral change!)
- [ ] Endpoint identification enabled by default for RMI over TLS (25.0.2)

---

# MIGRATION PHASES

Execute phases in order. Read the detailed reference for each phase before starting it. Always compile and test between phases.

## Phase 0 — Discovery

Scan build files, Dockerfiles, CI configs, dependencies, and codebase for removed/deprecated API usage. Categorize findings as blocking, warning, or informational. Do not change anything yet.

→ Read [references/phase-0-discovery.md](references/phase-0-discovery.md) for scan commands and procedure.

## Phase 1 — Build & Infrastructure

Update Java version in build files (Maven/Gradle), Dockerfiles (use JDK for build stage, JRE for run stage in multi-stage builds — preserve whatever pattern the codebase already uses), CI pipelines (GitHub Actions, Jenkinsfile, GitLab CI), and version pinning files. Get the first green build on JDK 25.

→ Read [references/phase-1-build.md](references/phase-1-build.md) for Maven/Gradle config, Docker image mappings, CI updates, and known landmines.

**Gate**: `mvn clean compile && mvn test` — all tests must pass before proceeding.

## Phase 2 — Breaking Changes & Removals

Fix all compilation failures and behavioral changes: SecurityManager removal, Unsafe warnings, COMPAT locale removal, Thread/ThreadGroup removals, removed CLI flags, annotation processing defaults, dependency version bumps, security certificate changes, and 2 subtle behavioral changes (CompletableFuture common pool, -Xlint:none).

→ Read [references/phase-2-breaking-changes.md](references/phase-2-breaking-changes.md) for the full list of 20 breaking change categories with fixes.

**Gate**: `mvn clean compile && mvn test` — all tests must pass. Cross-reference the MASTER CHECKLIST.

## Phase 3 — Language Feature Modernization

Adopt finalized Java 22–25 language features where they improve readability: unnamed variables (JEP 456), markdown doc comments (JEP 467), exhaustive switch, Stream Gatherers (JEP 485), module imports (JEP 511), flexible constructors (JEP 513), Scoped Values (JEP 506). No preview features unless explicitly asked.

→ Read [references/phase-3-language.md](references/phase-3-language.md) for feature details, code examples, and adoption guidelines.

**Gate**: `mvn clean compile && mvn test` — if any test fails after modernization, revert that change. Modernization must NOT change behavior.

## Phase 4 — AOT Cache Adoption (optional)

Configure Ahead-of-Time class loading for faster startup. Only if cold start matters for this project.

→ Read [references/phase-4-aot.md](references/phase-4-aot.md) for when it's worth it and adoption steps.

## Phase 5 — Performance Validation

Compare startup time, throughput, memory footprint, and GC behavior between JDK 21 and 25. Use JFR for profiling. Review GC changes (generational ZGC, G1 improvements, compact object headers).

→ Read [references/phase-5-performance.md](references/phase-5-performance.md) for comparison model and GC guidance.

## Phase 6 — Verification & Summary

Full clean build, static analysis (`jdeprscan`, `jdeps`), warning review, and migration report covering all changes made.

→ Read [references/phase-6-verification.md](references/phase-6-verification.md) for verification steps and report template.

---

# MIGRATION RUNBOOK

### Step 1: Make CI build Java 25 artifacts
Install JDK 25 in CI. Keep builds reproducible via toolchains.

### Step 2: Make the build fail fast on preview drift (if using preview features)
One place to define preview flags. Same flags for tests and runtime.

### Step 3: Run "compat mode" test pass
Run the app under typical production JVM flags. Capture warnings and turn them into tickets.

### Step 4: Canary rollout
1 service, 1 region, low traffic. Compare latency and error rates. Capture JFR before and after.

### Step 5: Full rollout and cleanup
Delete old flags only needed for the upgrade window. If you moved off legacy mechanisms (Security Manager, 32-bit builds), document it so nobody tries to resurrect them.

---

# RULES

1. **Always compile and test** after Phase 1 before Phase 2. After Phase 2 before Phase 3.
2. **Never force a feature** where it hurts readability.
3. **Preserve behavior**: Modernization must not change runtime behavior. If a test fails, revert.
4. **Skip preview features** unless explicitly asked. No `--enable-preview`.
5. **Check dependency versions first** when compilation fails — it's usually the library.
6. **One phase at a time**: Complete each phase fully.
7. **Report blockers immediately**: Don't silently work around incompatible dependencies.
8. **Run jdeprscan and jdeps** as part of verification.
9. **Do not modify test assertions** to make tests pass (unless asserting locale-specific formatting that changed with CLDR).
10. **Document every change** in the final summary.
11. **Come back to the MASTER CHECKLIST** after every phase. Verify nothing was missed.
12. **Use preview features only in leaf modules or internal tooling first** if adopting them.
13. **Never guess library versions** — always verify against authoritative sources (see Rule 13 detail below).
14. **Reproducible builds are non-negotiable** — every version pin must be explicit and verifiable (see Rule 14 detail below).
15. **JDK image for builds and tests, JRE image for runtime** — never use a JRE image as a build or test environment (see Rule 15 detail below).

---

## Rule 13 — Never Guess Library Versions

**Do not rely on your internal knowledge of what the "latest" or "compatible" version of a library is.** Training data has a cutoff, Maven Central indexing lags behind actual releases, and libraries release patch versions continuously. A version you believe is the latest may be months out of date, and a version you believe exists may not be published yet (or may have been retracted).

**The mandatory verification process for every dependency version change:**

1. **Check the library's GitHub releases page** — this is the ground truth. Release notes tell you exactly what JDK versions are supported, what was fixed, and whether the release is stable or pre-release.
   ```
   https://github.com/{org}/{repo}/releases
   ```

2. **Verify the artifact exists on Maven Central** — the search index lags, so query the repository directly:
   ```bash
   curl -s -o /dev/null -w "%{http_code}" \
     "https://repo1.maven.org/maven2/{group-path}/{artifact}/{version}/{artifact}-{version}.jar"
   # 200 = exists, 404 = does not exist
   ```

3. **Cross-check the changelog for JDK 25 compatibility** — look explicitly for "JDK 25 support", "Java 25", or "class file version 69". Do not assume compatibility from version numbers alone.

4. **Use the latest stable version that explicitly declares JDK 25 support** — not the latest pre-release, not the assumed latest. Pre-release versions (alpha, beta, RC, snapshot) are forbidden in production builds unless there is no stable alternative and the risk is explicitly documented.

**Real-world example**: During a JDK 25 migration, Lombok `1.18.42` existed in the local Maven cache but was not yet indexed in the Maven Central search API — making it look like a phantom version. Direct repository verification (`curl https://repo1.maven.org/...`) confirmed it was fully published on Central. The GitHub changelog confirmed `1.18.40` added JDK 25 support and `1.18.42` fixed a JDK 25 javadoc parsing bug — making it the correct version to use. Without checking both sources, the "obvious" fix would have been to downgrade to `1.18.38`, which has no JDK 25 support and would have silently broken annotation processing.

---

## Rule 14 — Reproducible Builds Are Non-Negotiable

Every artifact produced by the build system must be byte-for-byte reproducible given the same source code and tool versions. This means:

- **Pin every version explicitly** — no floating tags (`:latest`), no open ranges (`[1.0,)`), no `SNAPSHOT` dependencies in production builds.
- **JDK version**: pin to patch level (e.g., `25.0.2`) in all Dockerfiles, CI configs, and `.java-version`. A `FROM image:25` that silently pulls `25.0.3` tomorrow is a reproducibility failure.
- **Docker base images**: always use a versioned tag. `:latest` is banned. When a new patch ships, update the tag as an explicit, reviewable commit.
- **Maven plugins**: pin all plugin versions in `<pluginManagement>` or directly in the plugin declaration. Never rely on Maven's default plugin resolution — it will silently use different versions across environments.
- **The same image for the same role everywhere**: CI, local dev, and remote builds must use the same Docker base image for compilation. If CI compiles with a specific JDK 25 image pinned to a patch version, local Docker builds must use the exact same image and tag. Version drift between environments is a source of "works on my machine" failures that are extremely hard to debug.
- **Record the verification**: After confirming a version via GitHub releases and Maven Central, note the release date and what JDK support was added. This creates an audit trail for future migrations.

---

## Rule 15 — JDK Image for Builds and Tests, JRE Image for Runtime

The choice of Docker base image must match the role of the container:

| Role | Image type | Why |
|------|-----------|-----|
| Compile source code | JDK image (full JDK) | Needs `javac`, annotation processors, `javadoc` |
| Run unit/integration tests | JDK image (full JDK) | Needs `javac` for test compilation, JVM agent attachment (JaCoCo, Mockito byte-buddy), `jcmd` |
| CI pipeline container | JDK image (full JDK) | Runs Maven/Gradle, which compiles and tests |
| Production runtime | JRE image | Smallest attack surface, no compiler, no dev tools |
| Development server | JRE image | Should mirror production — if it needs the JDK, that's a red flag |

**The JRE runtime image is for running a pre-built JAR and nothing else.** Its job is:
```dockerfile
# Use your JRE 25 base image, pinned to a patch version
FROM eclipse-temurin:25-jre  # or your organisation's equivalent
COPY target/app.jar /app/app.jar
CMD ["java", "-jar", "/app/app.jar"]
```

**If your runtime Dockerfile needs `apt install`, `mvn`, schema init scripts, or any build tool — stop.** That logic does not belong in the runtime image. Move it to:
- Compose `healthcheck` + `depends_on` for service ordering
- A separate init container
- The CI pipeline or Makefile (the correct place for schema init and build steps)
- The application itself (e.g., Flyway/Liquibase for schema migrations)

**Never use a JRE runtime image as a CI build container.** JaCoCo, Mockito's byte-buddy, and annotation processors all require a full JDK. Tests will fail or produce incomplete coverage with a JRE-only image.
