# Phase 5 — Performance Validation

## 5.1 Before/after comparison model

Capture with **same workload, same heap sizing, same container limits**:

| Metric | Before (JDK 21) | After (JDK 25) |
|--------|-----------------|-----------------|
| P50 latency | | |
| P99 latency | | |
| Allocation rate | | |
| GC pause distribution | | |
| CPU utilization | | |
| Startup time | | |
| Memory footprint | | |

Use **JFR on both sides** — JDK 25's JFR improvements (JEP 518 cooperative sampling, JEP 520 method timing, JEP 509 CPU-time profiling on Linux) make profiling cheaper and more accurate.

## 5.2 GC considerations

- ZGC is now generational-only (non-generational removed in JDK 24). If you were using `-XX:+UseZGC` without `-XX:+ZGenerational`, the flag is no longer needed (generational is the default and only mode).
- Generational Shenandoah available in JDK 25.
- G1 has improvements: Region Pinning (22), Late Barrier Expansion (24), grouped card sets (25).
- Compact Object Headers (JEP 519) reduce heap footprint — enable with `-XX:+UseCompactObjectHeaders` (now a product option, no experimental unlock needed).

## 5.3 Virtual threads

JDK 24 (JEP 491) eliminates pinning on `synchronized`. Measure virtual thread scalability — it should be significantly better than JDK 21.
