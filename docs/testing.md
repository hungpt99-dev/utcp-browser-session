# Testing

## The rule

A test proves behaviour or it does not count. There are no mocked runtimes, no
mocked HTTP servers and no mocked browser in the suites below — except the one
component that cannot exist in CI: the Chrome extension in the integration tests,
which is replaced by a protocol-accurate websocket client that performs the same
ECDSA handshake. The end-to-end suite uses the real extension.

```bash
npm test                     # unit + integration + security (Node test runner)
npm run test:unit
npm run test:integration
npm run test:security
npm run test:e2e             # Playwright, real Chromium + unpacked extension
xvfb-run -a npm run test:e2e # same, on a headless Linux box
npm run bench                # performance comparison, writes docs/performance.json
```

## Suites

| Suite | Location | What it proves |
| --- | --- | --- |
| Unit | `tests/unit` | Pure policy: domain/URL checks, permission classification, schema inference, argument validation, redaction, manual generation and SDK validation |
| Integration | `tests/integration` | Real runtime + fixture site + signed websocket: pairing, handshake rejection, discovery ingestion, draft generation, the full execution pipeline |
| Security | `tests/security` | Credential leakage, cross-domain/SSRF attempts, redirect-to-metadata, token-less API access |
| E2E | `tests/e2e` | The real extension in Chromium: install, pair, discover, approve, generate a valid manual, execute read/write/destructive tools, session expiry, disconnect/reconnect |
| Benchmark | `tests/bench` | Direct browser fetch vs UTCP-mediated execution, p50/p95/p99, throughput, RSS |

## Unit tests

`tests/unit/domain.test.ts` — normalisation, hostname validation, loopback and
private-address handling, scheme/credential/injection rejection, port pinning,
redirect validation.

`tests/unit/permissions.test.ts` — the classification matrix, including the
"unknown method must require review" rule and the destructive-verb heuristics.

`tests/unit/schema.test.ts` — path templating (`/api/tasks/42` → `{id}`), tool
naming, shape → JSON Schema, schema merging across observations, argument
validation (unknown parameters are rejected, URL scalars are coerced) and request
construction.

`tests/unit/redact.test.ts` — header redaction, safe-header allowlisting, string
patterns (bearer, JWT, long tokens, cookie pairs) and deep object redaction.

`tests/unit/manual.test.ts` — drafts are excluded from the manual, the token is a
variable reference, the manual parses with the SDK's `UtcpManualSchema`, the
call-template serializer round-trips through the SDK registry, and tampered
manuals (literal token, wrong transport, bad namespacing, smuggled cookie) are
rejected.

## Integration tests

`tests/integration/pairing.test.ts` — the pairing code requires the runtime
token; claims from a web origin, from a mismatched `extensionId`, with a reused
code or an expired code are refused; a valid claim returns a client id and no
secret; the handshake accepts a correct signature and rejects a bad signature, a
stale timestamp, a foreign nonce, a non-extension origin and a revoked client;
a disconnect rejects the in-flight call.

`tests/integration/discovery.test.ts` — observations are recorded only while
capture is active and only for enabled domains; repeated observations merge and
union the inferred schema; drafts are generated but excluded from the manual and
refused by the executor; stopping discovery stops recording; the hub counters
prove data flowed.

`tests/integration/execution.test.ts` — unknown/draft/revoked tools, disabled
domains, invalid arguments, destructive confirmation, rate limiting, cross-domain
redirect blocking (with an audit event), same-origin redirect following (two
dispatch hops), 401 → `website_auth_expired` with no retry, 5xx →
`website_error`, unparseable JSON → `invalid_response`, oversized request body
refused before dispatch, oversized response truncated and flagged, and history
plus audit records for both successes and rejections.

### The fake extension

`tests/helpers/fake-extension.ts` pairs over the real HTTP endpoint (with a
`chrome-extension://` origin), opens a real websocket, signs the runtime's
challenge with a real P-256 key, and lets a test script the website's answer.
`Tamper` options inject a bad signature, stale timestamp, wrong nonce, foreign
origin or a silent handshake so the rejection paths are exercised, not assumed.

## End-to-end tests

`tests/e2e/acceptance.spec.ts` runs in one Chromium profile with the unpacked
extension and a real runtime, in order:

| Test | Asserts |
| --- | --- |
| AC-01 install | service worker URL, MV3 manifest, declared host permissions, popup renders |
| AC-01 dashboard | the runtime serves the dashboard, it renders, no page errors |
| AC-02 pairing | the popup pairs, the runtime reports a connected, authenticated client |
| AC-03 discovery | clicking the fixture UI produces the expected endpoint keys, a POST with request+response schema from the page tap, and no payload values in the store |
| AC-04 manual | drafts are excluded, approval makes them appear, `/api/v1/manual/validate` returns `ok` and `sdkValid` |
| AC-05 read | a real `UtcpClient` calls `browser.list_tasks`, the fixture receives a cookie-authenticated GET and the client gets the tasks |
| AC-06 write | a revoked tool is invisible and does nothing; approving it and calling it creates exactly one task |
| AC-06 destructive | a delete without `__confirm` is refused and mutates nothing; with it, exactly one row disappears |
| AC-07 expiry | an expired session yields `website_auth_expired`, exactly one request reaches the site (the 401) and no fallback is attempted |
| AC-08 unauthorised | a tool for a domain revoked at runtime is refused, recorded as `rejected`, and the fixture sees zero requests |
| AC-09 leakage | execution history, audit log and `state.json` contain no cookie, no `authorization`, no session secret, no runtime token, and the extension cannot read cookies |
| AC-10 timeout | a 5 s endpoint with a 1 s timeout returns a structured timeout and the runtime stays connected |
| AC-10 disconnect | unpairing drops the socket, calls fail with a browser error, the runtime survives, re-pairing restores execution |

## Benchmark

`tests/bench/benchmark.ts` boots the runtime as its own process, pairs the real
extension, generates a tool through the discovery path, then measures 200
requests two ways against the same endpoint: `fetch()` inside the extension
service worker, and `client.callTool()` through the full stack. It raises the
per-tool rate limit to its maximum for the run (200 samples would otherwise hit
the 60/min default) and records that in the output. Results are in
`docs/performance.json` and summarised in `docs/performance.md`.

## Conventions

- Every test file states what it proves, not how.
- Timeouts and polls instead of fixed sleeps for anything that crosses a process
  boundary (`expect.poll` in E2E, `waitFor` helper in integration).
- A test that needs a browser says so; nothing silently skips when a browser is
  missing — the run fails.
- Fixture data is deterministic (`packages/test-site/src/fixtures.ts`) so
  before/after state can be asserted exactly.
