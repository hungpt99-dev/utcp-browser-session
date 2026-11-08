# Changelog

All notable changes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
