# Performance

Measurements from `docs/performance.json`, produced by
`xvfb-run -a node tests/bench/benchmark.ts --requests 200`, plus the store
benchmark (`node tests/bench/store-writes.ts --count 300`).

## Environment

| | |
| --- | --- |
| CPU | AMD EPYC Processor, 6 cores (shared VPS) |
| OS / kernel | linux 6.8.0-147-generic |
| Node | v24.22.1 |
| Browser | Chromium (Playwright channel), extension loaded unpacked |
| Network | everything on loopback; fixture site is a local Node HTTP server |

This is a *loopback* measurement. Real websites add their own network latency,
which dominates everything below — the numbers here isolate the stack's own cost.

## What was compared

- **Direct** — `fetch(url, { credentials: 'include' })` inside the extension
  service worker, reading the body. This is the browser + local server path.
- **UTCP** — `UtcpClient.callTool() → provider → HTTP → runtime → websocket →
  service worker → website`, i.e. everything this project adds.

Both used the same approved tool, same endpoint (`GET /api/tasks?status=open&limit=10`),
same browser, 200 samples after 20 warm-up calls, sequential (no concurrency).

## Results — after the audit (this revision)

| Path | p50 | p95 | p99 | mean |
| --- | --- | --- | --- | --- |
| Direct browser fetch | 11.00 ms | 22.00 ms | 34.50 ms | 13.00 ms |
| Via UTCP provider | 26.00 ms | 61.71 ms | 83.68 ms | 30.63 ms |
| **Overhead** | **+15.00 ms** (2.36×) | +39.71 ms | +49.18 ms | +17.63 ms |

- **Throughput:** 32.6 calls/s sequential, 0 % error rate over the 200-sample run.
- **Schema validation + request construction:** 7.9 µs per call (10 000
  iterations, `validateArguments` + `buildRequest`).
- **Runtime RSS:** 107.7 MB after the run.

## Results — before the audit (commit `4f48201`)

| Path | p50 | p95 | p99 | mean |
| --- | --- | --- | --- | --- |
| Direct browser fetch | 9.00 ms | 20.10 ms | 24.70 ms | 10.39 ms |
| Via UTCP provider | 28.92 ms | 54.95 ms | 90.57 ms | 32.21 ms |
| **Overhead** | **+19.92 ms** (3.21×) | +34.85 ms | +65.87 ms | +21.82 ms |

Throughput was 31 calls/s, RSS 116.4 MB, validation 6.8 µs.

## Reading the two runs

The direct path was 2 ms slower in the new run and the UTCP path 2.9 ms faster;
on a shared VPS that is inside the noise floor (the direct p99 moved 24.7 → 34.5
ms with no code change on that path). What is *not* noise is the overhead:
**+19.9 → +15.0 ms p50 (−25 %)**, which matches removing two synchronous
full-document writes from every call.

The persistence change is measured separately, where the effect is unambiguous:

| | Before | After |
| --- | --- | --- |
| Store mutations per call | 3 full rewrites of `state.json` | 2 appends + 1 coalesced write |
| 300 calls — wall time | 1 916 ms | 76 ms |
| 300 calls — per call | 6.39 ms | **0.25 ms** |
| `state.json` after 300 calls | 229 KB | 2.5 KB |
| Audit / execution data | in the document (rewritten each time) | `audit.ndjson` 108 KB, `executions.ndjson` 170 KB (appended) |

At 60 calls/min (the default limit) the old path was already spending ~6 % of a
core on serialisation; at 600/min it was the throughput ceiling.

## Where the ~15 ms goes

Sequential calls, so each hop is paid in full:

1. client → runtime HTTP (`POST /api/v1/execute`): ~1–2 ms
2. runtime policy + validation + serialisation: ~0.1 ms
3. runtime → extension websocket frame: <1 ms
4. extension `fetch` to the website: the 11 ms baseline
5. response back over the websocket + envelope construction: ~1–2 ms
6. provider JSON parse + envelope return: <1 ms

The remainder is event-loop scheduling across three contexts (Node client,
Node runtime, Chrome service worker). There is no single hotspot; the cost is
the number of context switches, not any one of them.

## Concurrency

`maxInFlight` (default 8) bounds simultaneous browser calls and `maxQueue`
(default 32) bounds the queue; beyond that the runtime answers `busy` instead of
buffering. Queue wait is measured per call (`queuedMs`) and exposed as
percentiles at `GET /api/v1/metrics`, so overload is visible rather than
inferred. Sequential throughput above is *not* the concurrency ceiling.

## Interpreting it

- For an agent making a handful of calls per task, +15 ms is irrelevant next to
  model latency and the site's own response time.
- For a batch job, call tools concurrently: the runtime multiplexes by execution
  id, and the extension's `fetch` is parallel.
- If you need to scrape 10 000 pages, this is the wrong tool — use a crawler.

## Reproducing

```bash
npm run build
xvfb-run -a node tests/bench/benchmark.ts --requests 200
node tests/bench/store-writes.ts --count 300
```

The benchmark refuses to run if something is already listening on the benchmark
port, and writes `docs/performance.json` on every run. It does not fabricate
numbers: a failed run exits non-zero.
