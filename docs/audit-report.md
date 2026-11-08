# Architecture and security audit

Scope: the whole repository at commit `4f48201` (the first functional release),
re-audited module by module. Every item below was reproduced before it was
fixed, and every fix is covered by a test that fails without it.

Environment: Ubuntu 24.04.5, Node 24.22.1, Chromium 158 (Playwright), `@utcp/sdk`
1.2.0. Severities are assigned for a single-user developer tool running on
loopback: what would let an agent reach the wrong site, exceed its mandate, or
leak a credential ranks highest.

| # | Severity | Area | Finding | Status |
|---|----------|------|---------|--------|
| 1 | HIGH | Isolation | Domains were keyed by **hostname** while execution pinned an **origin**. Enabling a second app on the same host overwrote the first record's origin, so tools discovered on app A executed against app B. | Fixed |
| 2 | HIGH | Extension ↔ runtime | Popup `intent` frames were **silently dropped**. "Enable" and the discovery switch in the popup did nothing; discovery could only start from the dashboard API. | Fixed |
| 3 | HIGH | Reliability | No cap on in-flight calls and no bounded queue: an agent loop could open unbounded browser requests, and pending promises grew without limit. | Fixed |
| 4 | HIGH | Persistence | Every execution rewrote the entire state document synchronously, three times (measured **6.4 ms** per call, 229 KB at 500 records), blocking the event loop in the request path. | Fixed |
| 5 | HIGH | Policy | Permission classification used the HTTP method alone: `GET /tasks/1/delete` was READ (auto-executable), `POST /search` was WRITE. | Fixed |
| 6 | MEDIUM | Inference | Schema merging lost presence information: `required` was never derived, nullability was flattened, and a single sample produced `additionalProperties: true`. | Fixed |
| 7 | MEDIUM | Inference | Discovery produced no confidence signal, so a thin single-sample endpoint looked as trustworthy as a well-observed one. | Fixed |
| 8 | MEDIUM | Discovery | GraphQL, pagination, CSRF and upload/stream endpoints were invisible. Upload and stream endpoints would have been exposed as tools that could never work. | Fixed |
| 9 | MEDIUM | Session | No per-origin session state: a dead cookie was only discovered per call, and nothing reached the dashboard. | Fixed |
| 10 | MEDIUM | Cancellation | A client disconnect left the browser request running to completion; there was no way to cancel. | Fixed |
| 11 | MEDIUM | Dashboard | The bootstrap token travelled in `?token=` (server logs, `Referer`, browser history) instead of the URL fragment. | Fixed |
| 12 | MEDIUM | Extension memory | The discovery dedupe map grew without bound in the service worker. | Fixed |
| 13 | LOW | Audit | The audit trail was append-only but not tamper-evident. | Fixed |
| 14 | LOW | Persistence | A coalesced write could fire after the data directory was removed, throwing from a timer. | Fixed |
| 15 | LOW | Telemetry | `requestCount` was never incremented, so the dashboard's call counter was always zero. | Fixed |

## 1. Domain identity (HIGH)

`DomainRecord` carried both `domain` (hostname) and `origin`, but every lookup
used `domain`. `POST /api/v1/domains` with a second port on the same host found
the existing record and **overwrote** `origin`, leaving the first app's approved
tools pointing at the second app.

The fix makes the origin the canonical key end to end:

- `domain` in the store is now `scheme://host[:port]`; the hostname is kept
  separately and is still the security check applied to every request.
- Tools, endpoints, audit events, executions, session state and policies are all
  keyed or scoped by origin.
- Extension sync sends `enabledOrigins`; the popup shows origins; the execute
  frame carries `origin` and the extension re-validates it independently of the
  URL's hostname.
- A v1 → v2 migration lifts existing state files (hostname-keyed) without data
  loss.

Evidence: `tests/integration/isolation.test.ts` (two origins on `127.0.0.1`,
different ports: separate records, separate tools, correct dispatch target,
independent revocation) and `tests/e2e/multidomain.spec.ts` (two real sites in
one browser, signed in as different users, identity verified per origin).

## 2. Dropped popup intents (HIGH)

The popup cannot hold the runtime token, so it sends `{type:'intent'}` frames
over the authenticated socket. `ExtensionHub.dispatch` had no `intent` case and
fell through to `default: return`. The UI reported success and nothing happened.

The runtime now handles `enable_origin`, `disable_origin`, `discovery_start` and
`discovery_stop`, validates that the origin is `http:`/`https:`, audits every
action with actor `extension`, and re-pushes the allowlist. Discovery for an
origin that is not enabled is refused.

Evidence: `tests/integration/intents.test.ts` (enable, start/stop, refusal for an
unenabled origin, refusal for `file://`).

## 3. Concurrency (HIGH)

The hub had one unbounded `pending` map. Now:

- `maxInFlight` (default 8) calls run at once; further calls wait in a bounded
  queue (`maxQueue`, default 32).
- Beyond the queue the runtime answers `busy` instead of buffering.
- Queue wait is measured and reported per execution (`queuedMs`) and in
  `/api/v1/metrics`.
- Disconnect rejects both the in-flight and queued calls with structured errors.

Evidence: `tests/integration/concurrency.test.ts` (5 calls, limit 2/2 → 2 ran,
2 queued, 1 `busy`, peak concurrency 2, queue drained).

## 4. Persistence (HIGH)

Measured before: 300 executions took **1916 ms** (6.39 ms each) and grew
`state.json` to 229 KB, because executions and audit events lived in the state
document and each was a full rewrite.

Now executions and audit events go to append-only NDJSON logs (rotated at 8 MB),
and the state document holds only configuration. Both high-frequency counters
(`requestCount`, `lastExecutedAt`) coalesce into one write every 15 ms.

Measured after: 300 executions take **76–181 ms** (0.25–0.61 ms each across two
runs); `state.json` stays 2.5 KB. Security-relevant mutations (approvals, revocations, domain changes,
pairing) still write synchronously.

Evidence: `docs/performance.md`, and the same benchmark can be re-run.

## 5. Classification (HIGH)

`classifyPermission(method, path)` returned READ for any `GET`. That makes a
destructive GET look safe, and it contradicts the requirement that the method
alone must not decide.

The classifier now takes evidence: path verbs (destructive / read / write),
GraphQL operation names, whether a body was observed, response shape, and the
method as corroboration. Unknown shapes stay `confident: false`, which forces
review.

| Operation | Before | After |
|-----------|--------|-------|
| `GET /tasks/12` | READ | READ |
| `GET /tasks/12/delete` | READ | **DESTRUCTIVE** |
| `POST /search` (body) | WRITE | **READ** |
| `POST /graphql` + `DeleteIssue` | WRITE | **DESTRUCTIVE** |
| `POST /api/tasks` | WRITE | WRITE |
| `REPORT /api/tasks` | WRITE (unconfident) | WRITE (unconfident) |

Evidence: `tests/unit/permissions.test.ts`.

## 6–8. Inference and discovery (MEDIUM)

A single observation used to be merged into a finished schema, which discarded
how often each field appeared. Observations are now folded into an accumulator
that keeps presence counts, and the schema is derived from it:

- `required` only for fields present in **every** observation, and only after at
  least two observations (one sample never constrains a caller).
- nullable and union types stay visible (`type: ['string','null']` plus
  `nullable: true`) instead of widening to `{}`.
- small token-shaped value sets become `enum` (opt-in per origin).
- `additionalProperties: false` on objects that were fully observed.

Discovery also classifies the operation kind (rest / graphql / upload / download
/ stream), detects pagination style from the query keys and response fields, and
records whether a CSRF-style header was seen — all as explainable signals shown
in the dashboard. Uploads, streams and GraphQL operations are discovered and
classified but **not** turned into tools: without the request document or a
multipart body, a generated tool could not actually be executed, and exposing it
would be a lie.

`confidence` (0–1) combines sample count, sources, schema completeness,
classification certainty and status consistency; below 0.45 a draft is flagged
`reviewRequired`.

Evidence: `tests/unit/inference.test.ts`, `tests/integration/discovery.test.ts`.

## 9–10. Session state and cancellation (MEDIUM)

The extension reports what the website answered (401 → `expired`, < 400 → `ok`),
per origin, so the dashboard shows a dead session before the next call fails.
Sessions are never silently reused: the executor also records `expired` when a
call itself returns 401, and the error tells the user to sign in again.

A client disconnect now cancels the browser call: the HTTP layer watches the
response for `close`, the hub sends a `cancel` frame, and the extension aborts
its `AbortController`. The caller sees `aborted`.

Evidence: `tests/integration/concurrency.test.ts` (cancellation counter, hub
still usable afterwards), `tests/e2e/multidomain.spec.ts` (per-origin state).

## 11–15. Smaller fixes

- Dashboard token: read from `#token=` when present (fragments are never sent to
  the server), stripped from the URL, stored in `localStorage`; `?token=` still
  works for old links.
- Collector dedupe map: capped at 2 000 entries, oldest half pruned.
- Audit: every event hashes `prevHash` + its own fields; `/api/v1/audit/verify`
  recomputes the chain and names the first broken entry.
- Coalesced writes check that the data directory still exists.
- `requestCount` increments on a successful call.

## Second review pass

An independent review of the same tree found further issues. They are listed
here because they were real, and fixed the same way: reproduce, fix, test.

| # | Severity | Finding | Fix |
|---|----------|---------|-----|
| 16 | CRITICAL | One bearer token was both the agent's call credential and the admin credential, so a UTCP client could approve its own drafts, enable domains, rename tools or mint pairing codes. The approval model constrained nothing. | Two credentials: `runtime-token` (admin) and `agent-token` (execute-only). The agent credential may only call `/execute`, `/status`, `/manual` and `/manual/validate`; everything else returns 403. The manual and the provider use the agent credential. |
| 17 | HIGH | The provider attached its token to whatever `runtime_url` a manual declared — a prompt-injected manual could point it at an attacker. | The destination is pinned at `createBrowserSessionClient`; a template URL on another origin is refused before the header is attached, and with no pin only loopback is allowed. |
| 18 | HIGH | Revoking a paired browser did not disconnect it; it kept executing until it happened to drop. | Revocation closes the live socket (4003) and rejects its pending calls. |
| 19 | HIGH | Redirects were checked against the hostname only, so a redirect to another port on the same host passed. | `checkRedirect` now carries the pinned origin; a port hop is `redirect_blocked`. |
| 20 | HIGH | Path parameters were `encodeURIComponent`-ed, which leaves `..`; URL normalisation then turned `/api/tasks/..` into `/api/`, escaping the approved endpoint. | A path parameter must be one segment: `.`, `..`, `/`, `\`, `%2e`, `%2f`, `%5c` are refused with `invalid_arguments` before the URL is built. |
| 21 | MEDIUM | `csrf.bootstrapPath` accepted `//host:port`, a protocol-relative URL that leaves the pinned origin. | Schema requires `^/[^/]`; the extension also passes the pinned origin to `checkTargetUrl`. |
| 22 | MEDIUM | `isLoopbackDomain` matched any hostname starting with `127.`, so `127.0.0.1.evil.com` was treated as loopback and allowed over plain HTTP. | Only a literal IPv4 in 127/8, `localhost` and `[::1]` count. |
| 23 | MEDIUM | Secrets in query parameters and upstream error messages were persisted verbatim in executions and the audit log, contrary to the documented redaction guarantee. | Redaction moved to the persistence boundary (`Store.audit`, execution `path`/`errorMessage`), so every current and future caller is covered. |
| 24 | HIGH | A 1 MiB response body exceeded the 512 KiB frame limit, so a large response killed the websocket instead of being truncated. | The body cap is derived from the frame budget, `send()` measures the encoded frame and degrades a result to `truncated`, and responses are streamed with a hard cap instead of `arrayBuffer()`. |
| 25 | HIGH | The abort timer was cleared before the body was read, so a slow body could hang past the timeout and grow the worker without bound. | The timer now covers the read, and the reader is cancelled at the cap. |
| 26 | HIGH | After any reconnect the runtime started with an empty capture set while the extension kept recording, so every observation was dropped silently. | `sync` carries the runtime's `capturing` set and the extension treats it as authoritative. |
| 27 | HIGH | A deeply nested shape made zod throw `RangeError` inside an un-caught async handler, terminating the runtime process. | Depth is bounded at ingest, and the message handler catches and closes the socket instead of crashing. |
| 28 | MEDIUM | Discovery batches were drained before the send, so a failing socket silently lost them. | `peek`/`commit`: the buffer is only consumed after a successful write. |
| 29 | MEDIUM | Frames could be sent before the handshake completed, and a dead socket's `close` reset the state of the live one. | A `ready` gate buffers outbound frames until `sync`, `fail()` ignores displaced sockets, and re-pairing closes the old socket first. |
| 30 | MEDIUM | Capture state was computed from a stale cache outside the write queue, so `sync` and `discovery_start` could erase each other. | `setState` accepts a function evaluated inside the queue. |
| 31 | MEDIUM | MV3 suspended the worker and its listeners with it, losing buffered observations. | Loopback listeners are registered synchronously at module scope (so Chrome wakes the worker), and `onSuspend` flushes. |
| 32 | MEDIUM | Tap messages from page scripts were unvalidated and unthrottled. | Payload size, shape depth and a per-second budget are enforced in the worker. |
| 33 | LOW | The CSRF bootstrap fetch had no timeout or size cap; a takeover left the displaced socket's calls waiting out their timeouts; `safeEqual` leaked length; the manual was served unvalidated; the static-root check used a bare prefix. | Bounded fetch, pending calls rejected on adopt, digest comparison, validate-before-serve, separator-aware containment. |

Evidence: `tests/security/token-scope.test.ts` (scopes, provider pinning, path
traversal, redirect port hop, protocol-relative CSRF path, redaction, revocation
disconnect), `tests/unit/domain.test.ts` (loopback lookalikes),
`tests/integration/concurrency.test.ts` (cancellation),
`tests/integration/isolation.test.ts` (policy ceiling).

## Not found (checked, negative results)

- No path from the HTTP API to an arbitrary URL: every execution resolves a
  stored tool and re-validates the built URL against the tool's origin.
- No way for a caller to change policy: policy mutation requires the runtime
  bearer token and is not exposed through the MANUAL (tools only execute).
- No cookie, `Authorization` header or token in state, logs, audit, responses,
  the manual or the dashboard — covered by `tests/security/credential-leak.test.ts`
  and the AC-09 E2E test.
- The extension never reads `document.cookie`; execution relies on
  `credentials: 'include'` so HttpOnly cookies are attached by the network stack.

## Residual risk

Documented in `docs/limitations.md`: cookies are host-scoped (two apps on one
host share a cookie jar), redirects are refused rather than followed (opaque
redirect responses), schema capture needs an explicit opt-in and a permissive
CSP, and a compromised extension can act as the user inside the sites it was
granted — that is the trust boundary of the whole design.
