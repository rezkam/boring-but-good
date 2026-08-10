# Phase 0 — Discovery

Before changing anything, gather a complete picture of the project.

## 0.1 Identify build system and Java version references

```bash
# Find build files
find . -name "pom.xml" -o -name "build.gradle" -o -name "build.gradle.kts" -o -name "settings.gradle*" | head -20

# Find all Java version references
grep -rn "java.version\|sourceCompatibility\|targetCompatibility\|JavaVersion\|jvmToolchain\|languageVersion\|maven.compiler\|<source>\|<target>\|<release>" --include="*.xml" --include="*.gradle" --include="*.kts" --include="*.properties" .

# Version pinning files
find . -maxdepth 2 -name ".java-version" -o -name ".sdkmanrc" -o -name ".tool-versions" 2>/dev/null
```

## 0.2 Find all Dockerfiles and CI configuration

```bash
find . -name "Dockerfile" -o -name "*.Dockerfile" -o -name "docker-compose*" | head -20
find . -name "Jenkinsfile" -o -name ".github" -o -name ".gitlab-ci.yml" -o -name "Makefile" -o -path "*/.github/*.yml" 2>/dev/null | head -20
grep -rn "jdk\|java\|temurin\|corretto\|openjdk" --include="Dockerfile" --include="*.Dockerfile" --include="*.yml" --include="*.yaml" --include="Jenkinsfile" --include="Makefile" .
```

## 0.3 Inventory dependencies for JDK 25 compatibility

```bash
grep -n "lombok\|mockito\|byte-buddy\|bytebuddy\|jackson\|asm\|spring-boot\|hibernate\|javassist\|cglib\|objenesis\|mapstruct\|errorprone\|checker-framework\|guava\|netty\|kryo" pom.xml build.gradle* 2>/dev/null
```

## 0.4 Scan for usage of removed/deprecated APIs

```bash
# SecurityManager (permanently disabled JDK 24, JEP 486)
grep -rn "SecurityManager\|System.setSecurityManager\|System.getSecurityManager\|java.security.manager\|\.policy" --include="*.java" --include="*.properties" --include="*.xml" .

# sun.misc.Unsafe (deprecated JDK 23 JEP 471, warnings JDK 24 JEP 498)
grep -rn "sun.misc.Unsafe\|Unsafe\." --include="*.java" .

# Removed Thread/ThreadGroup methods (JDK 22-23)
grep -rn "Thread\.countStackFrames\|Thread\.suspend\|Thread\.resume\|ThreadGroup\.suspend\|ThreadGroup\.resume\|ThreadGroup\.stop\|ThreadGroup\.allowThreadSuspension" --include="*.java" .

# COMPAT/JRE locale provider (removed JDK 23)
grep -rn "java.locale.providers\|COMPAT\|locale.*JRE" --include="*.java" --include="*.properties" .

# Removed CLI flags
grep -rn "\-Xnoagent\|\-Xfuture\|\-checksource\|\-noasyncgc\|RegisterFinalizersAtInit\|UseEmptySlotsInSupers\|\-verbosegc\|\-noclassgc\|\-Xdebug\|\-debug\|UseZGC.*-ZGenerational\|\-XX:+UseNonGenerational" --include="Dockerfile" --include="*.sh" --include="*.yml" --include="*.xml" --include="*.properties" .

# jdk.random module (removed JDK 23)
grep -rn "jdk.random" --include="module-info.java" .

# JMX/JNDI removals (JDK 23-24)
grep -rn "MLet\|MLetMBean\|Context\.APPLET\|java.naming.rmi.security.manager\|JMXConnector.*getMBeanServerConnection.*Subject\|RMIIIOPServerImpl" --include="*.java" .

# Finalization (deprecated for removal since JDK 18)
grep -rn "protected void finalize\|Runtime\.runFinalization\|System\.runFinalization" --include="*.java" .

# String Templates (withdrawn in JDK 23)
grep -rn "STR\.\"\|FMT\.\"\|RAW\.\"\|StringTemplate" --include="*.java" .

# ThreadLocal usage (candidate for Scoped Values)
grep -rn "ThreadLocal" --include="*.java" .

# CompletableFuture async usage (behavioral change: now always uses common pool)
grep -rn "CompletableFuture.*Async\|supplyAsync\|runAsync" --include="*.java" .

# -Xlint:none (behavioral change: no longer implies -nowarn)
grep -rn "Xlint:none" --include="*.xml" --include="*.gradle" --include="*.kts" .
```

## 0.5 Assess codebase scope

```bash
find . -name "*.java" -path "*/src/main/*" | wc -l
find . -name "*.java" -path "*/src/test/*" | wc -l
```

## 0.6 Present findings

**Present a summary of findings before proceeding.** List every issue found, categorized by severity:

- **Blocking** — will not compile or run on JDK 25
- **Warning** — behavioral change or deprecation
- **Informational** — opportunity for modernization

Cross-reference against the MASTER CHECKLIST in SKILL.md.
