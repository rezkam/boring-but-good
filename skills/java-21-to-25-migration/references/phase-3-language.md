# Phase 3 — Language Feature Modernization

Apply **only finalized features** (no `--enable-preview`). Apply only where the change **improves readability or correctness**. Do NOT force features where they don't fit. Preserve behavior.

## 3.1 Unnamed Variables & Patterns — JEP 456 (JDK 22)

Replace unused variables with `_`:

```java
// catch blocks where exception is unused
try { ... } catch (IOException _) { return fallback; }

// enhanced for-loops with unused loop variable
for (var _ : collection) { count++; }

// lambda parameters
map.forEach((_, value) -> process(value));

// switch pattern cases
case Point(var x, _) -> useOnly(x);
```

**Detection**: `grep -rn "catch\s*(" --include="*.java"` — check if caught variable is used in the block.

## 3.2 Markdown Documentation Comments — JEP 467 (JDK 23)

Convert `/** */` to `///` markdown comments:

```java
/// Processes the input and returns the result.
///
/// @param input the input value
/// @return the processed result
/// @throws IllegalArgumentException if input is null
```

Apply to: small interfaces, enums, records, exception classes. Do NOT mass-convert large legacy Javadoc with complex HTML.

## 3.3 Exhaustive switch expressions

Convert old-style `switch` and `if-else` chains to arrow-form exhaustive switch expressions over enums and sealed types:

```java
return switch (status) {
    case ACTIVE   -> handle();
    case INACTIVE -> skip();
};  // exhaustive over enum, no default needed
```

## 3.4 Stream Gatherers — JEP 485 (JDK 24)

Use `stream.gather(...)` for custom intermediate operations:

```java
stream.gather(Gatherers.windowFixed(3))
stream.gather(Gatherers.windowSliding(5))
stream.gather(Gatherers.fold(() -> init, (state, elem) -> combine))
stream.gather(Gatherers.scan(() -> init, (state, elem) -> combine))
stream.gather(Gatherers.mapConcurrent(maxConcurrency, function))
```

Only use where it genuinely simplifies code — don't force for simple map/filter/reduce.

## 3.5 Module Import Declarations — JEP 511 (JDK 25)

```java
import module java.base;   // java.util.*, java.io.*, java.time.*, etc.
import module java.sql;     // java.sql.*, javax.sql.*
```

Consider for test classes. Do NOT replace explicit imports in production classes.

## 3.6 Flexible Constructor Bodies — JEP 513 (JDK 25)

Statements before `super(...)`/`this(...)`:

```java
// Validate/transform inline instead of static helper
public RangeFilter(int min, int max) {
    if (min > max) throw new IllegalArgumentException("min > max");
    super(min, max);  // statements allowed before super()
}
```

**Fields can be initialized before `super()`** — makes class more reliable when methods are overridden.

## 3.7 Scoped Values — JEP 506 (JDK 25)

Replace `ThreadLocal` set/try/finally/remove patterns:

```java
// BEFORE
private static final ThreadLocal<RequestContext> CTX = new ThreadLocal<>();
CTX.set(context);
try { doWork(); } finally { CTX.remove(); }

// AFTER
private static final ScopedValue<RequestContext> CTX = ScopedValue.newInstance();
ScopedValue.where(CTX, context).run(() -> doWork());
```

Use when: immutable per-request data, virtual threads, structured scope. Do NOT convert `ThreadLocal` that mutates within scope.

## 3.8 Compact Source Files — JEP 512 (JDK 25)

Instance `main` methods, implicit class declaration. The `IO` class now in `java.lang` requires explicit `IO.println()`.

**Skip for production code.** Useful only for scripts, demos, CLI tools.

## 3.9 API modernization

- `String.repeat()` instead of StringBuilder loops
- `Math.ceilDiv()` instead of manual ceiling division
- `SequencedCollection`: `getFirst()`, `getLast()`, `reversed()`
- `Inflater`/`Deflater` now `AutoCloseable` — use in try-with-resources
- `ForkJoinPool.submitWithTimeout()` for timeout-based task cancellation

## 3.10 Preview features (only if explicitly requested)

**Rule of thumb**: Use preview features only in leaf modules or internal tooling at first. Always compile and run with preview flags consistently across IDE, build, and CI.

- **Primitive Types in Patterns (JEP 507)**: extends instanceof/switch to all primitive types
- **Stable Values (JEP 502)**: "initialize later but optimize like final" — great for startup patterns
- **Structured Concurrency (JEP 505)**: extremely useful, still preview — adopt behind clear module boundaries
- **PEM Encodings (JEP 470)**: standard API for PEM encode/decode of crypto objects

## 3.11 Compile and test

```bash
mvn clean compile
mvn test
```

If any test fails after modernization, revert that specific change — modernization must NOT change behavior.
