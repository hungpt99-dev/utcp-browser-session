# Changelog

## 0.3.0 — first run in three actions

The release is about the distance between `git clone` and a working tool call.

### Added

- **`utcp-browser-session up`** — one command that builds what is missing, starts
  the runtime, prints both credentials and the dashboard URL, creates the pairing
  material, and launches Chrome with the unpacked extension in a throwaway
  profile. `up --demo` also starts the fixture site and enables it.
- **`utcp-browser-session down`** — stops a runtime started by `up`, using a
  pid/state file in the data directory.
- **Auto-pairing** — the runtime issues a one-time, in-memory, loopback-only
  pairing record bound to the extension id derived from the path `up` launched.
  The extension claims it and completes the ECDSA handshake itself; the popup no
  longer asks for a URL and a code. Manual pairing remains and is the fallback.
- **Auto-generated drafts in demo mode** — as discovery lands, drafts appear in
  the dashboard so the only remaining step is approval. Approval is never
  automatic.
- **Bundled CLI** — `dist/cli.mjs` via esbuild, no runtime dependencies.
- **`npm run package:extension`** — store-ready zip, listing text and privacy
  policy, written without an external `zip` binary.
- **Tests** — `tests/e2e/first-run.spec.ts` (the whole three-action flow against a
  real browser), `tests/security/auto-pair.test.ts` (replay, expiry, foreign
  origin, foreign extension id), `tests/security/extension-invariants.test.ts`
  (no `cookies` permission, no `document.cookie`, manual redirects, required
  permission set).
- **Docs** — `docs/packaging.md`, a regenerated quick start, an MP4 demo with a
  poster replacing a 4.2 MB GIF.

### Changed

- `npm run build` also produces the bundled CLI.
- The README quick start walks through three actions instead of eight steps.
- The demo GIF is gone; `docs/screenshots/demo.mp4` (131 KB) plus
  `demo-poster.png` replace it.

### Fixed

- An auto-pair code was not registered with the pairing store, so the extension
  could fetch a code it was unable to claim.
- `packageRoot()` resolved incorrectly in a published layout, where
  `extension/public` is not shipped but `extension/dist` is.

### Security

No invariant was relaxed. The extension still requests no `cookies` permission,
never reads `document.cookie`, keeps `redirect: 'manual'`, and drafts remain
invisible to manuals. Auto-pairing adds a credential-free claim step; it does not
replace or weaken the signed handshake, which still runs on every connection.

All notable changes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — 2026-11-08

Audit-driven revision. Every item below was found by inspecting the running
system, fixed, and is covered by a test that fails without the fix. Full detail:
`docs/audit-report.md`.

### Fixed

- **Origin is now the identity.** Domains were keyed by hostname while execution
  pinned an origin, so a second app on the same host silently repointed the
  first app's tools. Domains, endpoints, tools, policies, sessions, audit events
  and executions are all origin-scoped now; existing state files migrate on load.
- **Popup actions work.** `intent` frames (`enable_origin`, `disable_origin`,
  `discovery_start`, `discovery_stop`) were dropped by the runtime; the buttons
  appeared to work and did nothing. They are handled, validated and audited.
- **Bounded execution.** `maxInFlight` / `maxQueue` with a `busy` response beyond
  the queue, queue-wait measurement, and cancellation when the caller disconnects.
- **Hot-path persistence.** Executions and audit events moved to append-only
  NDJSON logs; the state document is written lazily. 6.39 ms → 0.25 ms per call,
  `state.json` 229 KB → 2.5 KB after 300 calls.
- **Classification no longer trusts the verb.** Path semantics, GraphQL operation
  names, body presence and response shape decide; unknown shapes stay
  `reviewRequired`.
- **Schema inference keeps evidence.** Multi-observation accumulators give real
  `required`, nullability, unions, enums and a confidence score instead of
  widening everything to `any`.
- **Dashboard token** is read from the URL fragment (never sent to the server)
  instead of the query string.
- **Discovery memory**: the dedupe map is capped and pruned.

### Security (second review pass)

- **Two credentials.** The runtime now issues an execute-only `agent-token` for
  UTCP clients next to the admin `runtime-token`. An agent can no longer approve
  its own drafts, enable domains, rename tools or mint pairing codes.
- The provider pins the runtime origin and refuses a `runtime_url` planted in a
  manual, so the token cannot be redirected.
- Revoking a paired browser disconnects it immediately.
- Redirects must match the pinned origin (a port hop is refused); path
  parameters are single segments (`..`, `/`, `%2e` refused); `csrf.bootstrapPath`
  cannot be protocol-relative; `isLoopbackDomain` no longer accepts
  `127.0.0.1.evil.com`.
- Redaction moved to the persistence boundary (audit + execution path/errors).

### Added

- Per-domain policy: permission ceiling, confirm-on-write, blocked path prefixes.
- Discovery classification for REST / GraphQL / upload / download / stream,
  pagination detection, CSRF hints, confidence scoring. GraphQL, uploads and
  streams are inventoried but never turned into tools (they cannot be replayed).
- Per-origin session state reported by the extension, surfaced in the dashboard.
- Correlation ids end to end, `queuedMs`, error categories and `GET /api/v1/metrics`
  with latency/queue percentiles.
- Hash-chained audit log with `GET /api/v1/audit/verify`.
- Workflow proposals derived from execution history (review only, never executed).
- Tests: 84 unit + 53 integration + 14 security + 14 E2E (165 total).

## [0.1.0] — 2026-11-08

First working release. Everything below is covered by an automated test unless
stated otherwise.

### Added

- **Chrome extension (MV3)** that pairs with a local runtime over a signed
  websocket (ECDSA P-256 challenge/response), executes approved requests with
  the browser's own session cookies, and observes API traffic while the user
  browses.
- **Local runtime** with a bearer-token HTTP API, dashboard hosting, domain
  allowlists, approval state, execution history and an append-only audit log.
- **UTCP provider** implementing `CommunicationProtocol` for `@utcp/sdk` 1.2.0
  under the `utcp_browser_session` call-template type, with a registered
  `CallTemplateSerializer` so manuals validate against `UtcpManualSchema`.
- **Discovery** in two layers: `webRequest` for method/path/query/status/content
  type, and an opt-in MAIN-world page tap for structural JSON request/response
  shapes (types only, never values).
- **Tool generation** from discovered endpoints with inferred JSON Schema,
  parameter locations, permission classification and human approval.
- **Execution pipeline** with argument validation, destructive confirmation,
  per-tool rate limiting, response truncation and structured error codes.
- **Dashboard** (React + MUI): overview, websites, tool explorer with test
  calls, execution inspector, security centre, settings.
- **Fixture website** with login, session cookies, CSRF tokens, read/write/
  destructive endpoints, slow/large/invalid responses and a request log.
- **Test suites**: unit, integration (protocol-accurate fake extension),
  security and end-to-end (real Chromium with the unpacked extension).
- **Benchmark** comparing direct browser fetch with UTCP-mediated execution.
- Documentation: architecture, security model, testing, performance,
  limitations, competitive analysis and an acceptance report.

### Known limitations

See `docs/limitations.md`. The important ones: Chrome and Chromium only,
same-origin JSON APIs only, response bodies are unavailable through
`webRequest`, and sites that require a same-origin `Origin` header on writes
cannot be called.
