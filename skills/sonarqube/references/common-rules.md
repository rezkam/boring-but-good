# Common SonarQube Rules and Fixes

## Table of Contents
- Logging issues (S3457, S2629)
- Unused code (S1128, S1068, S1481, S1172)
- Test conventions (S5786)
- Resource management (S1989)
- Data safety (S2386, S2184)
- Naming (S6213)

## S3457 — Use format specifiers instead of string concatenation

```java
// Bad
LOGGER.info("Processing: " + item.getId());
// Good
LOGGER.info("Processing: {}", item.getId());
```

## S2629 — Invoke methods only conditionally

```java
// Bad
LOGGER.debug("Result: " + expensiveOperation());
// Good
LOGGER.debug("Result: {}", expensiveOperation());
// For truly expensive operations:
if (LOGGER.isDebugEnabled()) {
    LOGGER.debug("Result: {}", expensiveOperation());
}
```

## S1128 — Remove unused imports

Remove any import statement that is not used.

## S1068 — Remove unused private fields

Remove any private field that is never read.

## S1481 — Remove unused local variables

Remove any local variable that is assigned but never used.

## S1172 — Remove unused method parameters

Remove unused parameters, or add `@SuppressWarnings("unused")` if kept for API compatibility.

## S5786 — Remove public modifier from JUnit 5 test classes

```java
// Bad
public class MyTest {
// Good
class MyTest {
```

## S1989 — Handle IOException from getWriter()

```java
// Bad
resp.getWriter().write("OK");
// Good
try (var writer = resp.getWriter()) { writer.write("OK"); }
```

## S2386 — Make mutable public fields protected

```java
// Bad
public static final List<String> items = new ArrayList<>();
// Good
protected static final List<String> items = new ArrayList<>();
```

## S2184 — Cast operands in integer division

```java
// Bad
double avg = total / count;
// Good
double avg = (double) total / count;
```

## S6213 — Rename methods matching restricted identifiers

Avoid method names like `record`, `var`, `yield` (restricted in newer Java versions).

```java
// Bad
void record(long value) { }
// Good
void addSample(long value) { }
```
