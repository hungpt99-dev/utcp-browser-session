# Acceptance report

Everything in this report was executed on the machine described below. Where a
criterion is only partially met, it says so. There is no PASS without a command
and its output.

## Environment

| | |
| --- | --- |
| Host | Ubuntu 24.04.5 LTS, kernel 6.8.0-147-generic, AMD EPYC, 6 cores, no swap |
| Node | v24.22.1 |
| Browser | Chromium 158 (Playwright `chromium` channel), extension loaded unpacked from `extension/dist` |
| UTCP SDK | `@utcp/sdk` 1.2.0 (official TypeScript SDK) |
| Display | `xvfb-run -a` (headless server) |
| Date | 2026-11-08 |

## Gate summary

| Gate | Command | Result |
| --- | --- | --- |
| Typecheck | `npm run typecheck` | **PASS** — `tsc -p tsconfig.json`, 0 errors, strict mode |
| Lint | `npm run lint` | **PASS** — `lint: clean` |
| Unit + integration + security | `npm test` | **PASS** — 110 tests, 0 failures, ~7 s |
| Production build | `npm run build` | **PASS** — `dashboard/dist/index.html`, `extension/dist/{background.js,manifest.json,popup/index.html}` |
| End-to-end | `xvfb-run -a npm run test:e2e` | **PASS** — 13 tests, 0 failures, ~15–20 s |
| Benchmark | `xvfb-run -a node tests/bench/benchmark.ts --requests 200` | **PASS** — 0 % error rate, `docs/performance.json` written |

Total automated tests: **123** (110 + 13).

## Criteria

### AC-01 — Clean installation · PASS

- **Scenario:** load the unpacked extension into a fresh Chromium profile.
- **Command:** `xvfb-run -a npx playwright test -c tests/e2e/playwright.config.ts --grep "AC-01"`
- **Expected:** install succeeds, the service worker starts, the popup renders, the runtime serves the dashboard, no runtime errors.
- **Actual:** service worker URL matches `chrome-extension://<id>/background.js`; manifest is MV3 with `host_permissions: ["http://127.0.0.1/*","http://localhost/*"]` and `optional_host_permissions: ["https://*/*"]`; the popup shows "Not paired"; the dashboard renders `Overview` with zero page errors (`pageerror` listener asserted empty).
- **Evidence:** `tests/e2e/acceptance.spec.ts` (tests 1–2), `test-results/e2e-results.json`, `docs/screenshots/02-dashboard-overview.png`.

### AC-02 — Runtime pairing · PASS

- **Scenario:** pair the extension through its popup; then attempt forged handshakes.
- **Command:** `node --test tests/integration/pairing.test.ts`, plus E2E test 3.
- **Expected:** pairing succeeds, the runtime identifies the extension, unauthorized clients cannot issue commands, disconnect/reconnect works.
- **Actual:**
  - Pairing through the popup returns a `clientId`, the runtime reports `connected: true` with the client label, and the extension receives the domain allowlist.
  - A claim without the runtime token is refused (401); a claim from `https://evil.example` is refused (403 `origin_not_allowed`); a mismatch between `extensionId` and the request origin is refused; a reused code and an expired code are refused (`pairing_invalid`).
  - Handshake rejections, each asserted: bad signature, stale timestamp (−10 min), foreign nonce, non-extension origin, revoked client. In every case the runtime never reports the client as connected.
  - A disconnect rejects in-flight executions with `extension_disconnected`; re-pairing restores execution (E2E test 13).
- **Evidence:** 13 integration tests in `tests/integration/pairing.test.ts`; E2E tests 3 and 13.

### AC-03 — API discovery · PASS

- **Scenario:** enable the fixture site with schema capture, start discovery, click through the fixture UI.
- **Command:** E2E test 4 (`--grep "AC-03"`).
- **Expected:** expected endpoints discovered, methods correct, no secrets stored, no unrelated domains, new tools remain drafts.
- **Actual:** `GET /api/tasks`, `POST /api/tasks`, `GET /api/tasks/{id}`, `DELETE /api/tasks/{id}` (plus the page's own `/api/csrf` and `/api/session`) are recorded; `POST /api/tasks` carries both a request and a response schema inferred from the page tap, with `sources: ["webRequest","page-tap"]`; the stored JSON contains no payload values (`Task from the fixture UI` absent), no password and no `sid=`; a discovery frame for a non-enabled domain is dropped (`observationsDropped ≥ 1`).
- **Evidence:** E2E test 4; `tests/integration/discovery.test.ts` (6 tests); `docs/screenshots/03-websites-discovery.png`.

### AC-04 — Manual generation · PASS

- **Scenario:** generate drafts, observe the manual, approve, validate.
- **Command:** E2E test 5; `node --test tests/unit/manual.test.ts`.
- **Expected:** the manual follows the official specification, SDK validation passes, parameters match the discovered schema, unauthorized endpoints are excluded.
- **Actual:** before approval `/api/v1/manual` has 0 tools; after approval `GET /api/v1/manual/validate` returns `{ ok: true, sdkValid: true, toolCount: ≥1 }`; tools parse with `UtcpManualSchema`; each tool uses `call_template_type: "utcp_browser_session"` and `pairing_token: "${UTCP_BROWSER_SESSION_TOKEN}"`; a draft endpoint never appears; a tampered manual (literal token, wrong transport, bad namespacing, smuggled cookie string) is rejected by `validateManualDocument`.
- **Evidence:** E2E test 5; `tests/unit/manual.test.ts` (6 tests).

### AC-05 — Read tool execution · PASS

- **Scenario:** a real `UtcpClient` calls `browser.list_tasks`.
- **Command:** E2E test 6.
- **Expected:** correct browser context, authenticated request reaches the site, expected result, structured response at the client.
- **Actual:** `client.callTool('browser.list_tasks', { status: 'open', limit: 10 })` returns `ok: true`, `status: 200`, a non-empty `body.tasks` where every task has `status === 'open'`. The fixture's request log shows a new `GET /api/tasks` with `hadSessionCookie: true` and status 200 at the same moment.
- **Evidence:** E2E test 6; site request log assertion inside the test.

### AC-06 — Write approval · PASS

- **Scenario:** a write tool revoked, then approved; a destructive tool without and with confirmation.
- **Command:** E2E tests 7–8.
- **Expected:** without approval the call is rejected and no mutation occurs; with approval exactly one mutation; destructive needs explicit confirmation.
- **Actual:** the revoked `browser.create_task` is absent from the client's tool list, the fixture's request count and task count are unchanged. After approval the call returns `201`, the fixture has exactly one new task with the expected title. For destructive: `delete_task` without `__confirm` throws `confirmation_required` and the task count is unchanged; with `__confirm: true` it returns `204` and exactly one task (the targeted id) is gone.
- **Evidence:** E2E tests 7–8; `tests/integration/execution.test.ts` (18 tests) for the same rules at the runtime level.

### AC-07 — Session expiration · PASS

- **Scenario:** invalidate the fixture session, then call a tool.
- **Command:** E2E test 9.
- **Expected:** a meaningful authentication error, no fallback request, a reconnect instruction.
- **Actual:** the call rejects with `website_auth_expired`; the hint reads "Sign in again at … in the same browser, then retry. No other request was attempted."; the fixture's request log grew by exactly one entry (the 401) — no retry, no direct HTTP fallback.
- **Evidence:** E2E test 9.

### AC-08 — Unauthorized domain · PASS

- **Scenario:** a tool bound to a domain that is no longer authorized.
- **Command:** E2E test 10; `tests/security/ssrf.test.ts`.
- **Expected:** the request is rejected, the target server receives zero requests, a security event is recorded.
- **Actual:** the domain is disabled at the API, which revokes its tools; the call returns `ok: false` with `tool_revoked`; a new execution record has `outcome: "rejected"` and the right domain; the audit log has a `tool.rejected` event; the fixture's request log is unchanged. Security tests additionally prove that a private-address tool is refused with `private_address_blocked` without reaching the browser, and that an argument containing `http://169.254.169.254/…` is percent-encoded into the path of the allowed origin.
- **Evidence:** E2E test 10; `tests/security/ssrf.test.ts` (9 tests).

### AC-09 — No credential leakage · PASS

- **Scenario:** run the workflow, then scan every artefact.
- **Command:** E2E test 11; `node --test tests/security/credential-leak.test.ts`.
- **Expected:** no cookies in logs, no authorization headers in the audit log, no session credentials in tool responses, no credentials in manuals.
- **Actual:** execution history, audit log and `state.json` contain none of `sid=`, `set-cookie`, `authorization`, `correct-horse`, `Bearer `. A hostile fake extension that returns `set-cookie` and `x-auth-token` headers produces an envelope containing neither; the persisted response preview shows `[REDACTED]` where the token-shaped value was; the generated manual contains no runtime token and references `${UTCP_BROWSER_SESSION_TOKEN}` only. The extension has no `cookies` permission and `chrome.cookies` is absent, so it cannot read the session at all.
- **Evidence:** E2E test 11; `tests/security/credential-leak.test.ts` (6 tests).

### AC-10 — Reliability · PASS

- **Scenario:** timeout, browser disconnect, malformed response, oversized bodies, revoked permission.
- **Command:** E2E tests 12–13; `tests/integration/execution.test.ts`.
- **Expected:** the runtime stays stable and returns structured errors.
- **Actual:** a 5 s endpoint with a 1 s timeout yields `timeout` and the runtime remains connected; unpairing drops the socket, calls fail with `extension_disconnected` (or `tool_revoked` when the domain was revoked), `/api/v1/status` still answers 200, and re-pairing restores successful execution; unparseable JSON yields `invalid_response`; a 300 KiB body is refused with `request_too_large` before dispatch; an oversized response is truncated and flagged.
- **Evidence:** E2E tests 12–13; 18 integration tests.

### AC-11 — Build and regression · PASS

- **Command:** `npm run verify:full`
- **Actual:** typecheck 0 errors, lint clean, 110 tests pass, dashboard + extension build, 13 E2E tests pass. No test is skipped; a skipped test would be reported as a failure of this criterion.
- **Evidence:** terminal output of the gate; `test-results/e2e-results.json`.

## Performance

See `docs/performance.md` and `docs/performance.json` for the raw data.

| Metric | Value |
| --- | --- |
| Direct browser fetch (p50/p95/p99) | 9.00 / 20.10 / 24.70 ms |
| Via UTCP provider (p50/p95/p99) | 28.92 / 54.95 / 90.57 ms |
| Overhead | +19.92 ms p50 (3.21×) |
| Throughput (sequential) | 31 calls/s, 0 % errors |
| Schema validation + request build | 6.8 µs/call |
| Runtime RSS | 116.4 MB |

## Deviations and honest gaps

1. **Discovery response bodies come from a page tap, not `webRequest`.** MV3 does
   not expose bodies to `webRequest` (verified by experiment before design). The
   consequence: on sites whose CSP blocks the tap, schema capture degrades to
   method/path/status only. Documented in `docs/limitations.md`.
2. **Redirects are refused rather than validated-and-followed in the browser.**
   `redirect: 'manual'` returns an opaque response without a readable `Location`.
   The runtime still contains and tests destination validation for a real `3xx`.
3. **AC-08 exercises revocation, not "a domain that was never enabled".** Because
   disabling a domain revokes its tools, the observable rejection code is
   `tool_revoked`. Both codes are refusals; the test asserts the stronger one and
   the audit trail.
4. **One browser profile per runtime.** Pairing a second extension replaces the
   connection. Multi-session isolation is on the roadmap, not implemented.
5. **No Chrome Web Store listing.** The extension is loaded unpacked; a store
   review would be the next step for distribution.
6. **The benchmark is loopback-only.** It isolates stack overhead; it says nothing
   about a real site's latency.
7. **`npm audit` reports a zod advisory** inherited from `@utcp/sdk` with no fixed
   3.x release. Mitigated by hard message-size and collection caps; recorded in
   `SECURITY.md`.
8. **The E2E suite requires a display.** It runs under `xvfb-run` here and in CI;
   `npm run verify:full` encodes that.
