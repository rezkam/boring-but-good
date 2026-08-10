# Phase 1 — Build & Infrastructure

**Goal**: Make the build capable of producing Java 25 bytecode and running the test suite on JDK 25.

> **Before touching any version number** — read Rule 13 and Rule 14 in SKILL.md. Every version
> you write must be verified against the library's GitHub releases page AND confirmed to exist on
> Maven Central via a direct HTTP check. The search index lags. Your training data is stale.
> Reproducible builds require explicit, verified pins — not guesses.

## 1.1 Build files

### Maven (`pom.xml`)

Update all Java version properties:
- `<java.version>` → `25`
- `<maven.compiler.source>` / `<maven.compiler.target>` / `<maven.compiler.release>` → `25`
- `maven-compiler-plugin` `<source>`, `<target>`, `<release>` → `25`

**Use `--release 25`** (or `<release>25</release>`) instead of separate `-source`/`-target`. Per Oracle guide: supported `-source`/`-target` values are 25 (default) through 9. Value 8 is deprecated.

Verify plugin versions — **known landmine**: there are reported Java 25 compatibility issues in specific `maven-compiler-plugin` versions (see [GitHub #986](https://github.com/apache/maven-compiler-plugin/issues/986)). Fix is: upgrade the plugin (and sometimes Maven itself).
- `maven-compiler-plugin` ≥ 3.14.0 (check for 25 compat fixes) — **verify on GitHub + Maven Central before pinning**
- `maven-surefire-plugin` ≥ 3.5 — **verify on GitHub + Maven Central before pinning**
- `maven-failsafe-plugin` ≥ 3.5 — **verify on GitHub + Maven Central before pinning**
- Maven itself ≥ 3.9.9

**These version floors are minimums, not recommendations.** Always verify the actual latest stable release via the library's GitHub releases page and Maven Central direct URL check. Do not use version numbers from this document without verifying them first — they may be outdated.

Check `<argLine>` and `MAVEN_OPTS` for obsolete JVM flags (see Phase 2.5).

If annotation processors stop running, add explicit `<proc>full</proc>` to compiler config (Phase 2.7).

### Gradle (`build.gradle` / `build.gradle.kts`)

**Known landmine**: There is real friction running Gradle 8 on JDK 25 (see [GitHub #35111](https://github.com/gradle/gradle/issues/35111)). Use **Gradle toolchains** to *compile/test* with JDK 25 even if Gradle itself runs on a different JDK:

```kotlin
java {
    toolchain {
        languageVersion.set(JavaLanguageVersion.of(25))
    }
}
```

Gradle's compatibility rules explicitly separate "running Gradle" from "using Java for compilation/testing" — exploit this. Keep the Gradle runtime on a known-good JDK if you hit wrapper failures.

Gradle wrapper must be ≥ 8.10 for JDK 25 compilation support.

### Framework compatibility

- **Spring Boot**: check the [Spring Boot System Requirements](https://docs.spring.io/spring-boot/system-requirements.html) page for the version you are using — compatibility declarations change with each minor release. Do not rely on this document for a specific version claim; verify directly.
- Spring Boot applications can be converted to Native Image using GraalVM — check the GraalVM release notes for JDK 25 support status.

## 1.2 Dockerfiles

### Image role discipline — read this first

**Every Dockerfile has a role. Match the image type to the role. This is non-negotiable.**

| Role | Image type | Rationale |
|------|-----------|-----------|
| CI pipeline, Maven/Gradle build | **JDK image (full JDK)** | Needs `javac`, annotation processors (Lombok, MapStruct), Maven/Gradle |
| Running tests (unit, integration) | **JDK image (full JDK)** | JaCoCo agent, Mockito byte-buddy, and test compilation all require a full JDK |
| Production runtime | **JRE image** | Minimal attack surface — runs a pre-built JAR, needs nothing else |
| Development server (local docker-compose) | **JRE image** | Should mirror production; if it needs the JDK, that is a design problem |

**The JRE runtime image does exactly one thing**: `java -jar app.jar`. It must not contain build tools, package managers, schema init scripts, or anything that is not needed to run the pre-built application JAR. If you find yourself adding `apt install`, `mvn`, or shell scripts that talk to databases to a runtime Dockerfile — stop and move that logic to the CI pipeline, Makefile, or Compose setup where it belongs.

### Updating image references

Replace all JDK 21 base images with their JDK 25 equivalents. **Always pin to the patch version tag** — never use `:latest` (see Rule 14 in SKILL.md):

```dockerfile
# CI / build / test environments — use a JDK image, never JRE
FROM eclipse-temurin:25-jdk          # public Docker Hub
# or your organisation's equivalent, pinned to a patch version:
# FROM <internal-registry>/<jdk25-build-image>:<patch-version>

# Production runtime — use JRE
FROM eclipse-temurin:25-jre          # public Docker Hub
# or your organisation's equivalent:
# FROM <internal-registry>/<jre25-runtime-image>:<patch-version>
```

Common public image substitutions (verify tag availability before using — tags change between patch releases):
- `eclipse-temurin:21-jdk` → `eclipse-temurin:25-jdk`
- `eclipse-temurin:21-jre` → `eclipse-temurin:25-jre`
- `amazoncorretto:21` → `amazoncorretto:25`

If your organisation maintains hardened or certified base images in a private registry, consult your internal toolchain documentation for the JDK 25 image name and version tag. Do not assume the naming convention carried over from JDK 21 — verify. Always pin to a specific patch-level tag.

### Multi-stage build pattern

```dockerfile
# ── Build ──────────────────────────────────────────
# Use your JDK 25 image — public or internal, pinned to patch version
FROM eclipse-temurin:25-jdk AS builder
WORKDIR /build
COPY pom.xml .
RUN mvn dependency:go-offline -B
COPY src/ src/
RUN mvn clean package -DskipTests -B

# ── Runtime ────────────────────────────────────────
# Use your JRE 25 image — public or your organisation's equivalent
FROM eclipse-temurin:25-jre
COPY --from=builder /build/target/app.jar /app/app.jar
EXPOSE 8080
CMD ["java", "-jar", "/app/app.jar"]
```

Preserve the existing Dockerfile structure — if the codebase already uses multi-stage builds, keep the same structure and only update image tags. If it uses a single-stage JDK image for the run stage, do not introduce multi-stage unless asked.

Check for JVM flags in `ENTRYPOINT`/`CMD`/`ENV` — remove obsolete flags (Phase 2.5).

## 1.3 Dependency version verification

**Do this before writing a single version number.** Your internal knowledge of what version is "latest" or "compatible" is unreliable — training data is stale, Maven Central's search index lags behind actual releases, and libraries publish patch versions continuously. A version you believe exists may be a 404. A version you downgrade to may lack JDK 25 support.

### The verification process (mandatory for every version change)

**Step 1 — GitHub releases page**

Go to the library's GitHub releases page and find the newest stable release that explicitly mentions JDK 25 (or "Java 25", "class file version 69") in its release notes or changelog:

```
https://github.com/{org}/{repo}/releases
```

Read the changelog entries carefully. "JDK 25 support added" in a release means compilation and annotation processing work. Look for follow-up patch releases that fix JDK 25-specific bugs — those are usually the version you actually want.

**Step 2 — Confirm the artifact exists on Maven Central**

The search API (`search.maven.org`) lags by hours or days after a release. Always verify the artifact directly:

```bash
curl -s -o /dev/null -w "%{http_code}" \
  "https://repo1.maven.org/maven2/{group/path}/{artifact}/{version}/{artifact}-{version}.jar"
# 200 = published and available  |  404 = does not exist
```

Example — checking JaCoCo 0.8.14:
```bash
curl -s -o /dev/null -w "%{http_code}" \
  "https://repo1.maven.org/maven2/org/jacoco/jacoco-maven-plugin/0.8.14/jacoco-maven-plugin-0.8.14.jar"
# Returns 200 even when search.maven.org still shows 0.8.13 as "latest"
```

**Step 3 — Record your findings**

Before committing, note for each changed dependency:
- Version selected
- GitHub release date
- What JDK compatibility was declared in the release notes
- Result of the Maven Central direct URL check

This creates an audit trail and prevents re-litigating the same research next time.

### Key libraries to check for JDK 25 support

These libraries interact deeply with the JVM and are most likely to need updates:

| Library | Why it matters | What to check |
|---------|---------------|---------------|
| **Lombok** | Annotation processor that hooks into `javac` internals | Changelog must explicitly say "JDK 25 support added" — each JDK version requires a dedicated release |
| **JaCoCo** | Instruments bytecode at class-file level — must understand JDK 25 class file format (version 69) | GitHub releases, look for "Java 25" or class file version mention |
| **Mockito** | Uses byte-buddy for subclassing — byte-buddy must support JDK 25 | Mockito changelog; byte-buddy is a transitive dep so check both |
| **maven-compiler-plugin** | Drives `javac` — must pass `--release 25` without error | GitHub releases, Apache JIRA |
| **maven-surefire-plugin** | Forks JVM for tests — must work with JDK 25 JVM args | GitHub releases |
| **Hibernate** | Uses reflection and byte manipulation | Hibernate changelog |
| **gRPC / Netty** | Native transport and reflection-heavy | gRPC and Netty GitHub releases |

### Real-world lesson

During a JDK 25 migration, `lombok-1.18.42` was present in a project's local Maven cache but returned no results from the Maven Central search API — making it look like a non-existent version. A direct `curl` to `repo1.maven.org` returned HTTP 200, confirming it was fully published on Central. The Lombok changelog confirmed `1.18.40` added JDK 25 support and `1.18.42` fixed a JDK 25 javadoc parsing bug, making it the correct version to keep. Without checking both sources, the apparent "fix" would have been to downgrade to `1.18.38` — which has no JDK 25 support and would have silently broken annotation processing across the whole project.

**Always check both sources. Never trust one alone.**

## 1.4 CI configuration and version pinning

- `.java-version` → `25` (or a full patch version like `25.0.x` for stricter pinning)
- `.sdkmanrc` → `java=25.0.x-tem` (replace `x` with the patch you verified)
- `.tool-versions` → `java temurin-25.0.x` (replace `x` with the patch you verified)
- GitHub Actions `setup-java`: `java-version: '25'`, `distribution: 'temurin'` (or your chosen distribution)
- Jenkinsfile / GitLab CI: update JDK tool references and Docker image tags

**Reproducible builds require patch-level pinning.** `java-version: '25'` in GitHub Actions resolves to the latest `25.x.y` available on the runner — which can change silently when GitHub updates its tool cache. For maximum reproducibility, prefer a Docker-based CI pipeline where the exact JDK image is pinned by patch version in the Dockerfile and committed to the repo. When a new JDK patch ships, it becomes an explicit, reviewable commit rather than a silent environment change.

## 1.5 First compilation and test

```bash
mvn clean compile -DskipTests
mvn test
```

If compilation fails, triage:
1. **Plugin version** → upgrade maven-compiler-plugin, surefire, etc.
2. **"unknown release" error** → upgrade the plugin (known issue)
3. **Dependency incompatibility** → update the library (Phase 2.15)
4. **Removed API** → fix in Phase 2
5. **`--add-opens`/`--add-exports`** → check if still needed after dependency updates

Record baseline: total tests, pass, fail, skip. **All tests should pass before proceeding.**
