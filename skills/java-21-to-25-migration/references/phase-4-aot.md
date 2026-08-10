# Phase 4 — AOT Cache Adoption (optional)

The AOT cache (Project Leyden) speeds startup and warmup. JEP 483 (JDK 24) → JEP 514 (JDK 25) → JEP 515 (JDK 25).

## 4.1 When it's worth it

**Use if**: You care about cold start and warmup (serverless, autoscaling, CLI tools, "first request latency"). You redeploy often enough that startup time is a real cost.

**Skip if**: You are dominated by network/DB/huge lazy initialization. Your app is tiny and already starts instantly.

## 4.2 Adoption model

1. **Measure baseline**: time-to-first-request and time-to-steady-state throughput
2. **Turn on AOT cache in staging**: validate functional equivalence
3. **Roll to one service** with the most painful startup
4. **Keep a kill switch** (deploy without caches) until you trust it

JDK 25 simplifies this with `--aot` ergonomics (JEP 514) and method profiling reuse (JEP 515).
