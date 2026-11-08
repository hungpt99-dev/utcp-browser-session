# Performance

Measurements from `docs/performance.json`, produced by
`xvfb-run -a node tests/bench/benchmark.ts --requests 200`.

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

## Results

| Path | p50 | p95 | p99 | mean |
| --- | --- | --- | --- | --- |
| Direct browser fetch | 9.00 ms | 20.10 ms | 24.70 ms | 10.39 ms |
| Via UTCP provider | 28.92 ms | 54.95 ms | 90.57 ms | 32.21 ms |
| **Overhead** | **+19.92 ms** (3.21×) | +34.85 ms | +65.87 ms | +21.82 ms |

- **Throughput:** 31 calls/s sequential, 0 % error rate over the 200-sample run.
- **Schema validation + request construction:** 6.8 µs per call (10 000
  iterations, `validateArguments` + `buildRequest`), i.e. ~0.02 % of the p50.
- **Runtime RSS:** 116.4 MB after the run (standalone runtime process, `VmRSS`).

A second run on the same machine measured +19.16 ms and 28.5 calls/s, so treat
the overhead as "≈20 ms p50 on this hardware" rather than a precise constant.
The shared VPS shows noticeable jitter (p99 of the direct path moved between
24 ms and 64 ms across runs).

## Where the ~20 ms goes

Sequential calls, so each hop is paid in full:

1. client → runtime HTTP (`POST /api/v1/execute`): ~1–2 ms
2. runtime policy + validation + serialisation: ~0.1 ms
3. runtime → extension websocket frame: <1 ms
4. extension `fetch` to the website: the 9 ms baseline
5. response back over the websocket + envelope construction: ~1–2 ms
6. provider JSON parse + envelope return: <1 ms

The remainder is event-loop scheduling across three contexts (Node client,
Node runtime, Chrome service worker). There is no obvious single hotspot; the
cost is the number of context switches, not any one of them.

## Interpreting it

- For an agent making a handful of calls per task, +20 ms is irrelevant next to
  model latency and the site's own response time.
- For a batch job, call tools concurrently: the runtime multiplexes by execution
  id, and the extension's `fetch` is parallel. Sequential throughput (31/s) is
  not the ceiling.
- If you need to scrape 10 000 pages, this is the wrong tool — use a crawler.

## Reproducing

```bash
npm run build
node scripts/make-icons.mjs        # only needed if icons are missing
xvfb-run -a node tests/bench/benchmark.ts --requests 200
```

The script refuses to run if something is already listening on the benchmark
port, and writes `docs/performance.json` on every run. It does not fabricate
numbers: a failed run exits non-zero.
