# Phase 2 — Breaking Changes & Removals

Check each item against the codebase. Not all will apply.

## 2.1 Security Manager permanently disabled (JDK 24, JEP 486)

`System.setSecurityManager()` and `System.getSecurityManager()` throw `UnsupportedOperationException`. The API will be removed in a future release.

**If you still rely on SecurityManager**: Your plan is NOT "find the new flag" — it's "replace the model" (process isolation, container hardening, policy at infra level). Various `Permission` classes deprecated for removal in JDK 25.

Remove: all `SecurityManager` usage, `Policy` files, `-Djava.security.manager` flags.

## 2.2 sun.misc.Unsafe memory-access methods (JDK 23-25)

- JDK 23 (JEP 471): Memory-access methods deprecated for removal
- JDK 24 (JEP 498): Runtime warnings on first use
- JDK 22: `shouldBeInitialized()`/`ensureClassInitialized()` removed
- JDK 22: `park`/`unpark`/`getLoadAverage`/`xxxFence` deprecated

Superseded by: `VarHandle` API (JEP 193, JDK 9), Foreign Function & Memory API (JEP 454, JDK 22).

Check both project code AND dependencies (Netty, Kryo, LMAX, etc.). Warnings from Maven/Guice/Spring internals are expected — note but don't try to fix.

## 2.3 COMPAT locale data removed (JDK 23)

`JRE`/`COMPAT` locale data provider permanently removed. CLDR is the only locale data source. `java.locale.useOldISOCodes` deprecated for removal in JDK 25.

Test date/time, number, currency formatting. If differences are unacceptable, create a custom `LocaleServiceProvider` with `-Djava.locale.providers=SPI,CLDR`.

## 2.4 Thread and ThreadGroup removals (JDK 22-23)

- JDK 22: `Thread.countStackFrames()` removed
- JDK 23: `Thread.suspend()`/`resume()`, `ThreadGroup.suspend()`/`resume()`/`stop()` removed

Use `java.util.concurrent` constructs instead.

## 2.5 Removed command-line options and flags (JDK 22-25)

**Removed** (JVM will fail to start):
- JDK 24: `-t`, `-tm`, `-Xfuture`, `-checksource`, `-cs`, `-noasyncgc`
- JDK 23: `-Xnoagent`, `RegisterFinalizersAtInit`
- JDK 24: Non-Generational ZGC mode (use generational, now default)
- JDK 22: `jdeps -profile`/`-P`

**Deprecated for removal** (warnings, will break in future):
- JDK 24: `-verbosegc`, `-noclassgc`, `-verify`, `-verifyremote`, `-ss`, `-ms`, `-mx`
- JDK 23: `-XX:+UseEmptySlotsInSupers`, `PreserveAllAnnotations`, `DontYieldALot`, `UseNotificationThread`
- JDK 25: `UseCompressedClassPointers`, VFORK launch (Linux)
- JDK 22: `-Xdebug`, `-debug`
- JDK 24: `LockingMode` flag, `LM_LEGACY`/`LM_MONITOR` modes

Scan: Dockerfiles, scripts, CI configs, `JAVA_TOOL_OPTIONS`, `MAVEN_OPTS`, `JVM_OPTS`, application config.

## 2.6 Removed APIs (JDK 22-25)

**JDK 25**: `SynthLookAndFeel.load`, `BasicSliderUI()` constructor, `Socket` constructors for datagram sockets, old JMX system properties, PerfData sampling, `sun.rt._sync*` counters, Baltimore CyberTrust + Camerfirma root certs, SunPKCS11 PBE SecretKeyFactory implementations
**JDK 24**: `Window.warningString`, `Context.APPLET`, JNDI `rmi.security.manager`, JNDI remote code download disabled, JMX `serialVersionUID` compat logic, GTK2, "EST"/"MST"/"HST" time zones
**JDK 23**: `MLet`/`MLetMBean`, JMX Subject Delegation, `jdk.random` module, Thread/ThreadGroup methods
**JDK 22**: `Thread.countStackFrames()`, Unsafe methods

Run: `jdeprscan --release 25 -l --for-removal` on compiled classes.

## 2.7 Annotation processing default change (JDK 23+)

Implicit annotation processing may no longer trigger automatically. If processors (Lombok, MapStruct, etc.) stop running:

```xml
<configuration>
    <proc>full</proc>
</configuration>
```

## 2.8 Null checks in inner class constructors (JDK 22+)

Inner class constructors now null-check the enclosing instance. Tests that reflectively create inner classes with null outer will throw NPE. Extremely rare workaround: `-XDnullCheckOuterThis=false` (unsupported).

## 2.9 Final record pattern variables (JDK 22+)

Variables in record patterns are effectively final. Assignment is a compile error.

## 2.10 CompletableFuture behavioral change (JDK 25)

**Important**: `CompletableFuture` and `SubmissionPublisher` async methods without an explicit Executor now **always** use the `ForkJoinPool.commonPool()`. Previously, a new thread was created when common pool parallelism < 2.

If your app runs in constrained environments (single-core containers), this may change async behavior. Test thoroughly.

## 2.11 -Xlint:none behavioral change (JDK 25)

`-Xlint:none` no longer implies `-nowarn`. If your build uses `-Xlint:none,serial`, the `serial` warnings will now appear as expected. Adjust build config if needed.

## 2.12 Socket constructor change (JDK 25)

`java.net.Socket` constructors with `SocketImplFactory` accepting datagram now throw `IllegalArgumentException`. Use `DatagramSocket` instead.

## 2.13 RMI over TLS endpoint identification (JDK 25.0.2)

Endpoint identification now enabled by default for RMI connections over TLS. May cause TLS connection failures if server certificate lacks matching Subject Alternative Name. Workaround: `jdk.rmi.ssl.client.enableEndpointIdentification=false`.

## 2.14 Virtual threads no longer pin on synchronized (JDK 24, JEP 491)

No code changes needed. **Opportunity**: Revert `ReentrantLock` workarounds that were only done to avoid virtual thread pinning.

## 2.15 Native access restrictions (JDK 24, JEP 472)

Warnings for JNI and FFM API usage. Default `--illegal-native-access=warn` in JDK 24+.

If your app uses `System.loadLibrary`, native methods, or FFM API:
- Add `--enable-native-access=ALL-UNNAMED` to JVM args
- Run with `--illegal-native-access=deny` to identify all sites
- Use `jnativescan` tool to identify JNI-using libraries

## 2.16 Dynamic agent loading

Warnings continue from JEP 451 (JDK 21). If using `-XX:+EnableDynamicAgentLoading`, check if still needed after dependency updates.

## 2.17 String Templates withdrawn (JDK 23)

Feature removed entirely. Replace `STR."..."`, `FMT."..."`, `RAW."..."` with `String.format()` or concatenation.

## 2.18 Dependency compatibility

| Dependency | Min Version for JDK 25 | Notes |
|---|---|---|
| **Lombok** | ≥ 1.18.34 | Annotation processor; sensitive to javac changes |
| **Mockito** | ≥ 5.14 | Uses ByteBuddy for bytecode generation |
| **ByteBuddy** | ≥ 1.15 | Must support class file version 69.0 |
| **Jackson** | ≥ 2.18 | Reflection-based serialization |
| **ASM** | ≥ 9.7 | Class file format support |
| **Spring Boot** | 3.3+ / 4.x | 4.0.2 explicitly supports Java 25 |
| **Spring Framework** | 6.2+ / 7.x | Underlying framework |
| **Hibernate** | ≥ 6.6 | Bytecode enhancement |
| **MapStruct** | ≥ 1.6 | Annotation processor |
| **Gradle** | ≥ 8.10 | Build tool (use toolchains!) |
| **Maven** | ≥ 3.9.9 | Build tool |
| **maven-compiler-plugin** | ≥ 3.14.0 | Check for 25 compat patches |
| **Javassist** | ≥ 3.30 | Bytecode manipulation |

## 2.19 Security updates (JDK 22-25)

**JDK 25**: SHAKE128-256/256-512 digests, HKDF in SunPKCS11, TLS Keying Material Exporters, SHA-3 ECDSA in XML Security, enhanced jar validation, `java.security.debug` now includes thread/timestamp by default
**JDK 24**: Security properties file inclusion, quantum-resistant ML-KEM (JEP 496) + ML-DSA (JEP 497), configurable TLS session tickets
**JDK 23**: Thread/timestamp debug options, KeychainStore-ROOT

**Removed certificates**: Baltimore CyberTrust Root (JDK 25), two Camerfirma roots (JDK 25), SunPKCS11 PBE SecretKeyFactory implementations (JDK 25)

**Security migration checklist**:
1. Inventory custom `java.security` overrides and disabled algorithms lists
2. Inventory TLS settings (cipher suites, protocols, keystores)
3. Run integration tests that exercise real TLS handshakes to your endpoints
4. If using RMI over TLS, test with the new default endpoint identification (JDK 25.0.2)
5. If you have long-lived secrets or compliance pressure, evaluate post-quantum algorithms (ML-KEM, ML-DSA from JDK 24)

## 2.20 Fix deprecation warnings from upgraded libraries

After upgrading libraries and the JDK toolchain, **compile with deprecation warnings visible and fix them.** Deprecated-for-removal APIs will become compile errors in the next major version of the library or the JDK — fixing them now avoids a second migration later.

```bash
mvn clean compile -Dmaven.compiler.showDeprecation=true 2>&1 | grep -i "deprecated"
```

**Common patterns when upgrading Hibernate, Jackson, gRPC, and other major libraries:**

| Library | Deprecated API | Replacement | Since |
|---------|---------------|-------------|-------|
| Hibernate 7 | `Session.update(entity)` | `Session.merge(entity)` | 7.0 (removed) |
| Hibernate 7 | `Session.get(Class, id)` | `Session.find(Class, id)` | 7.0 (deprecated for removal) |
| Hibernate 7 | `Session.save(entity)` | `Session.persist(entity)` | 7.0 (removed) |
| Hibernate 7 | `Session.delete(entity)` | `Session.remove(entity)` | 7.0 (removed) |
| Hibernate 7 | `Session.saveOrUpdate(entity)` | `Session.merge(entity)` | 7.0 (removed) |
| JDK 25 | `sun.misc.Unsafe` memory-access | `VarHandle` / Foreign Memory API | JDK 23 (warnings JDK 24+) |

**Process:**
1. Run a full compile and capture all deprecation warnings
2. Group warnings by library — deprecations from the same library upgrade share a migration path
3. Fix each group: check the library's migration guide for the replacement API
4. If a deprecation comes from a transitive dependency (e.g., Lombok using `sun.misc.Unsafe`), check whether a newer version of that dependency fixes it. If no fix exists upstream, document it and move on — do not suppress the warning
5. Re-compile and verify zero new deprecation warnings from your own code

**Do not suppress deprecation warnings with `@SuppressWarnings("deprecation")` unless the deprecated API has no replacement yet and the situation is documented.** The goal is to align with the current API contract of every library you upgraded.

## 2.21 Compile and test

```bash
mvn clean compile
mvn test
```

All existing tests must pass. Fix remaining issues before proceeding.

**Cross-reference the MASTER CHECKLIST** — verify all blocking items are addressed.
