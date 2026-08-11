# Tool-handler benchmarks

This opt-in benchmark calls the `Read`, `Grep`, and `ListFiles` handlers directly. It makes no network or API requests, does not start an agent or LLM, and does not require credentials. Use the live LLM harness separately to measure model tool-selection behavior.

## Run

Install `rg` and the project dependencies, then run:

```bash
npm run benchmark:tools
```

The default run records ten fresh-worker samples per scenario. Each sample worker first performs two in-process warmups, then records one measurement. Override the counts or output path when needed:

```bash
npm run benchmark:tools -- --warmups 3 --samples 20 --output /tmp/tool-handlers.json
```

Large runs can target one or more scenarios by repeating `--scenario`:

```bash
npm run benchmark:tools -- --scenario grep-content --scenario list-files-full-walk
```

Available scenarios are `read-large-text`, `grep-content`, `grep-count`, `list-files-first-page`, `list-files-full-walk`, and `list-files-typescript`.

Without `--output`, reports are written to `benchmarks/tool-handlers/output/`. That directory is ignored by Git; benchmark artifacts must not be committed.

## Workloads and isolation

The runner constructs a deterministic temporary fixture with:

- a 2,000-line text file for `Read`;
- 10,240 TypeScript files with one known match each for `Grep`;
- 10,500 visible entries, crossing the 10,000-entry `ListFiles` traversal boundary;
- ignored and hidden files that must not affect complete traversal totals.

`list-files-first-page` measures traversal to the boundary and cursor creation. `list-files-full-walk` follows every cursor or legacy offset until traversal is complete.

Fixture construction, worker startup, TypeScript loading, warmups, cursor cleanup after warmups, and result validation are outside the measured interval. Every recorded sample gets a fresh Node worker. Its warmups run inside that same worker so handler modules and JIT state are warm without leaking state between recorded samples. If Node exposes `global.gc`, the runner requests collection between warmup and measurement.

If a sample exceeds its timeout, the parent requests cooperative cancellation and waits for the handler to finish cleanup before rejecting the sample. This aborts an active `rg` subprocess and stops ListFiles traversal. Worker termination is only used as a bounded fallback after the cancellation grace period.

The harness validates only safe invariants while recording exact observations such as returned count, total, truncation, cursor use, exactness, and page count. This allows the same workloads to capture behavior differences from older handler revisions instead of rejecting their older output shapes or pagination caps. Tests on the current revision assert its exact expected observations with a smaller fixture.

## Baseline comparison

Pass an earlier report to add machine-readable median and p95 deltas to the new report:

```bash
npm run benchmark:tools -- \
  --baseline /tmp/tool-handlers-before.json \
  --output /tmp/tool-handlers-after.json
```

Comparisons report absolute and percentage changes for every shared metric. They never pass or fail based on a timing threshold. Compare reports produced on the same machine, with the same Node and `rg` versions, fixture, scenarios, warmup count, and sample count.

The runner persists a workload fingerprint covering fixture contents, fixture size, scenario arguments, and execution modes. It warns when fingerprints or scenario sets differ, and marks scenarios whose correctness observations changed. Treat latency deltas for scenarios with different workloads, returned counts, pagination, or result shapes as behavioral comparisons rather than equal-work speedups.

## Report format

Reports use schema version `2` and retain every raw sample. Numeric summaries include count, minimum, maximum, mean, median, and nearest-rank p95. Environment metadata includes the Git SHA, Node version, `rg` version, platform, architecture, CPU model and logical count, and total system memory.

Each sample records handler wall time, output size, and Node process CPU, RSS, heap, external, and array-buffer metrics. Output size is summarized as a numeric metric rather than treated as a correctness observation. Wall time includes waiting for the `rg` subprocess, but Node process CPU and memory metrics do not include that subprocess. Memory deltas may be negative when garbage collection runs.

Correctness and schema tests intentionally contain no timing gates. For useful comparisons, close unrelated workloads and inspect raw distributions and observations alongside summaries.
