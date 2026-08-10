# Java 21 → 25 Migration Skill

Guide your AI agent through upgrading a Java project from JDK 21 to JDK 25 — the latest Long-Term Support release (September 2025).

## Why

Jumping four JDK versions means dozens of JEPs, removed APIs, behavioral changes, and new language features to consider. This skill gives the agent a structured, phase-by-phase migration plan so nothing gets missed — from build files and Dockerfiles all the way through language modernization and performance validation.

## What it covers

- **Build & infrastructure** — Maven/Gradle config, `.java-version` files
- **Dockerfiles & containers** — Update all base images (Temurin, Corretto, etc.) to JDK 25, remove obsolete JVM flags from entrypoints
- **CI pipelines** — Update all CI stages and configs (GitHub Actions, Jenkinsfile, GitLab CI, Makefiles) to build and test with JDK 25
- **Breaking changes & removals** — SecurityManager (permanently disabled), `sun.misc.Unsafe` memory-access warnings, removed Thread/ThreadGroup methods, COMPAT locale data, withdrawn String Templates, removed CLI flags
- **Behavioral changes** — `CompletableFuture` async now always uses common pool, `-Xlint:none` no longer implies `-nowarn`, virtual threads no longer pin on `synchronized`
- **Dependency compatibility** — Spring Boot, Gradle, Maven Compiler Plugin, Lombok, ByteBuddy, ASM, and other common libraries
- **Language modernization** — Unnamed Variables (JEP 456), Markdown doc comments (JEP 467), exhaustive switch, Stream Gatherers (JEP 485), Module Imports (JEP 511), Flexible Constructors (JEP 513), Scoped Values (JEP 506)
- **Security** — Quantum-resistant ML-KEM/ML-DSA, Key Derivation Function API, native access restrictions, dynamic agent loading
- **AOT cache adoption** — Ahead-of-Time Class Loading & Linking, command-line ergonomics, method profiling
- **Performance** — GC improvements (G1 region pinning, generational ZGC/Shenandoah, compact object headers), JFR CPU-time profiling, cooperative sampling
- **New APIs** — 19 notable non-JEP additions (HttpResponse limiting, ForkJoinPool scheduling, AutoCloseable Inflater/Deflater, SHAKE digests, and more)

## How it works

The skill defines 7 phases, each with clear entry/exit criteria and a mandatory compile-and-test gate:

| Phase | Focus |
|-------|-------|
| **0 — Discovery** | Scan build files, Dockerfiles, dependencies, and usage of removed APIs |
| **1 — Build & Infrastructure** | Update version numbers, base images, CI config; get first green build |
| **2 — Breaking Changes** | Fix removals, deprecations, behavioral changes, dependency bumps |
| **3 — Language Modernization** | Adopt Java 22–25 language features where they improve readability |
| **4 — AOT Cache** | Optional: configure Ahead-of-Time class loading for faster startup |
| **5 — Performance Validation** | Compare startup time, throughput, memory; tune GC if needed |
| **6 — Verification & Summary** | Clean build, static analysis, warning review, migration report |

A **54-item master checklist** (organized by category: language, libraries, security, runtime, deprecations, removals, preview) is revisited after every phase to make sure nothing slips through.

## What it tracks

- **35 finalized JEPs** spanning JDK 22 through 25
- **5 preview/incubator JEPs** (flagged as do-not-use without `--enable-preview`)
- **19 non-JEP API additions** new in JDK 25
- **Build tool landmines** — Gradle #35111, Maven Compiler Plugin #986
- **2 subtle behavioral changes** that compile fine but change runtime semantics

## Installation

```bash
npx skills add rezkam/boring-but-good --skill java-21-to-25-migration
```

Or install manually — run `./setup.sh` from the repo root or see [SKILL.md](SKILL.md) for manual setup.

No configuration needed — this is a self-contained prompt with no scripts or secrets.
