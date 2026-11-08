<div align="center">

<img src="docs/assets/banner.svg" alt="UTCP Browser Session — turn your existing authenticated browser sessions into AI-callable tools" width="880" />

**Your browser is already logged in. Let your agent use it — without ever touching a cookie.**

[![License: MIT](https://img.shields.io/badge/license-MIT-3b82f6.svg)](LICENSE)
[![Chrome MV3](https://img.shields.io/badge/chrome-MV3-8b5cf6.svg)](#compatibility)
[![UTCP 1.2.0](https://img.shields.io/badge/utcp-1.2.0-22c55e.svg)](https://github.com/universal-tool-calling-protocol/typescript-utcp)
[![Tests](https://img.shields.io/badge/tests-178%20passing-22c55e.svg)](#development)
[![Node 24](https://img.shields.io/badge/node-%E2%89%A522.18-339933.svg)](#quick-start)

[Quick start](#quick-start) · [How it works](#how-it-works) · [Security](#security) · [Compatibility](#compatibility) · [Docs](#documentation) · [Roadmap](#roadmap)

</div>

---

UTCP Browser Session turns the websites you are already signed in to into
**UTCP tools an AI agent can call**. A Chrome extension observes the API behind
a page you use, you review what it found, and the agent calls it later — with the
browser attaching your existing session at the network layer.

No cookie export. No per-site server. No OAuth app per integration. No stealth.

```text
UTCP client  →  utcp_browser_session  →  local runtime  →  Chrome extension  →  website
                 (real @utcp/sdk)        (approvals,        (your session,
                                          audit)             never readable)
```

## Demo

Recorded from a real run — the fixture site, the runtime, and the unpacked
extension, no mockups:

<div align="center">
  <img src="docs/screenshots/demo.gif" alt="Pairing the extension, discovering the fixture API, approving a draft tool and executing it through the dashboard" width="820" />
</div>

| | |
| --- | --- |
| ![Extension popup](docs/screenshots/01-extension-popup.png) | ![Dashboard overview](docs/screenshots/02-dashboard-overview.png) |
| **Pairing and status** in the popup: connected, one approved domain capturing | **Overview** after a real run: 10 discovered APIs, 1 approved, 1 execution |
| ![Websites](docs/screenshots/03-websites-discovery.png) | ![Tool approval](docs/screenshots/04-tool-approval.png) |
| **Discovery**: what the extension actually saw, with permission classification | **Review**: a draft write tool with its inferred input schema |
| ![Execution](docs/screenshots/05-tool-execution.png) | ![Inspector](docs/screenshots/06-execution-inspector.png) |
| **Execution** from the inspector — the JSON is the real 201 response | **Inspector**: sanitized metadata, redacted preview, no headers |

## The problem

An agent that needs your Jira, Linear, Notion or internal admin panel usually
means one of: a dedicated MCP server per service, a personal access token, or an
OAuth app you have to register and consent to. That is a lot of integration work
for capabilities you *already have open in a tab*.

Existing browser-automation projects solve a different problem: they launch their
own browser and drive a page. That browser is not logged in, and every action
pays DOM-interaction cost.

This project takes the third path: reuse the session, call the API, and leave the
credential where it already lives.

## How it works

```mermaid
flowchart LR
    A["UTCP client<br/>(agent)"] -->|callTool| B["Provider<br/>utcp_browser_session"]
    B -->|"POST /api/v1/execute"| C["Local runtime<br/>approvals · audit · policy"]
    C -->|WebSocket| D["Extension service worker"]
    D -->|"fetch(credentials: 'include')"| E["Website API"]
    E --> D --> C --> B --> A
    F["Page tap<br/>(opt-in, MAIN world)"] -.->|"JSON shapes, never values"| D
```

1. **Pair once.** The popup asks for a one-time code from the runtime; the
   extension generates an ECDSA P-256 key pair and keeps the private half. The
   runtime stores only the public half.
2. **Enable a site.** Exact hostname plus a pinned origin. Nothing else on the
   internet becomes reachable.
3. **Discover.** With capture on, the extension records method, path, query names,
   status and content type via `webRequest`. If you enable schema capture, a
   page-level tap also reports the *structure* of JSON requests and responses
   (types only, never values).
4. **Review.** Discovery produces **draft** tools. A human approves them, renames
   them, or throws them away. Nothing is executable until then.
5. **Call.** The agent calls a tool; the runtime validates arguments and policy,
   the extension performs the request with the browser's own cookies, and the
   result comes back as a structured envelope.

## Features

Everything below is implemented and covered by a test.

| Feature | What it does |
| --- | --- |
| **Native UTCP transport** | `BrowserSessionCommunicationProtocol` extends the official `CommunicationProtocol`; a `CallTemplateSerializer` is registered for the `utcp_browser_session` type. Manifests validate with `UtcpManualSchema`. |
| **Session reuse without extraction** | Requests run in the extension service worker with `credentials: 'include'`. Chrome attaches HttpOnly cookies at the network layer; extension JavaScript never reads them. |
| **Per-origin isolation** | The origin is the unit of everything: two apps on one host never share a record, a policy, a session state or a cookie. Re-validated on both sides of the websocket. |
| **Domain policy** | Per-domain ceiling (`READ` / `WRITE` / `DESTRUCTIVE`), optional confirm-on-write, blocked path prefixes. Enforced at execution time, never by relabelling a tool. |
| **API discovery** | `webRequest` inventory plus opt-in structural schema capture. Classifies REST / GraphQL / upload / download / stream, detects pagination, records CSRF hints, and scores confidence 0–1. Start/stop per origin, from the dashboard or the popup. |
| **Separate agent credential** | The runtime issues an execute-only token for UTCP clients and keeps an admin token for you. An agent cannot approve a tool, enable a domain or change policy — the approval gate is a credential boundary, not a convention. |
| **Human-reviewed tool generation** | Draft tools with input schema, parameter locations, permission level and discovery provenance. Approve, rename, revoke, delete. |
| **Permission levels** | `READ` / `WRITE` / `DESTRUCTIVE` from evidence, not the verb alone: path semantics, GraphQL operation name, body shape; unknown operations stay `review required`. Destructive calls need `__confirm`. |
| **Argument validation** | JSON Schema validation before anything leaves the runtime; unknown parameters are rejected, not ignored. |
| **CSRF bootstrap** | Optional, explicitly configured: the extension fetches a token from a documented JSON endpoint with the session cookie and attaches it to writes. |
| **Structured errors** | A stable code catalogue (`website_auth_expired`, `redirect_blocked`, `confirmation_required`, …) with an actionable hint and no secrets. |
| **Audit trail** | Approvals, executions, rejections, redirects, pairing attempts, handshake failures — redacted and hash-chained, with `GET /api/v1/audit/verify` to detect tampering. |
| **Bounded execution** | `maxInFlight` concurrent browser calls, a bounded queue, `busy` beyond it, cancellation when the caller disconnects, and per-call `queuedMs` in the metrics. |
| **Observability** | Correlation ids across client → runtime → extension → audit, latency/queue percentiles at `GET /api/v1/metrics`, error categories on every execution. |
| **Workflow proposals** | Optional: repeated tool sequences in the execution history become reviewable proposals with inferred parameter bindings. Never auto-executed. |
| **Dashboard** | Websites, tool explorer with test calls, workflow proposals, execution inspector, security centre with audit-chain verification, limits. |
| **Fixture site** | A deterministic local website with login, CSRF, destructive endpoints, expiry, slow/large/invalid responses and a request log. |

## Quick start

Requirements: **Node ≥ 22.18** (Node 24 recommended — the packages are TypeScript
sources run directly), **Chrome or Chromium ≥ 116**, and `xvfb` if you want the
E2E suite on a headless box.

```bash
git clone https://github.com/hungpt99-dev/utcp-browser-session.git
cd utcp-browser-session
npm install
npm run build            # dashboard/dist + extension/dist
```

**1. Start the fixture website** (a local site with a login and a JSON API):

```bash
npm run site             # http://127.0.0.1:8788
```

**2. Start the runtime** in another terminal:

```bash
npm run runtime
```

It prints two credentials and a dashboard link:

```text
  listening   http://127.0.0.1:8777
  admin token 4f1c…   ~/.utcp-browser-session/runtime-token   (you, the dashboard)
  agent token 9a02…   ~/.utcp-browser-session/agent-token     (what a UTCP client uses)
  Dashboard   http://127.0.0.1:8777/#token=4f1c…
```

The admin token approves tools and changes policy. The agent token can only run
approved tools, so an AI client cannot approve its own drafts. Give the agent the
*agent* token and nothing else.

**3. Load the extension**: `chrome://extensions` → Developer mode → **Load
unpacked** → select `extension/dist`.

**4. Pair**: click the extension icon, paste the runtime address
(`http://127.0.0.1:8777`) and a pairing code:

```bash
npm run pair             # prints a one-time code
```

**5. Sign in and enable the site**: open <http://127.0.0.1:8788>, sign in as
`alice` / `correct-horse`. In the dashboard → **Websites**, enter the site URL,
the CSRF bootstrap path `/api/csrf`, and press **Enable**. Press **Start
discovery**.

**6. Make some traffic**: click the buttons on the fixture page (list, create,
get, delete). The endpoint table fills in.

**7. Approve a tool**: **Generate drafts**, then **Tools** → pick
`browser.create_task` → **Approve tool**.

**8. Call it from a UTCP client**:

```js
import { createBrowserSessionClient } from '@utcp-browser-session/provider';

const { client, manual } = await createBrowserSessionClient({
  runtimeUrl: 'http://127.0.0.1:8777',
  token: process.env.UTCP_BROWSER_SESSION_TOKEN,
});

console.log(manual.success);                       // true
console.log((await client.getTools()).map(t => t.name));
const result = await client.callTool('browser.create_task', {
  title: 'Filed by an agent',
  priority: 2,
});
console.log(result.status, result.body.task.id);   // 201 101
```

Or from a shell:

```bash
UTCP_BROWSER_SESSION_TOKEN=$(cat ~/.utcp-browser-session/agent-token) \
  npm run manual:cli | head -40
```

## Example: turning a local authenticated API into a UTCP tool

The fixture exposes `POST /api/tasks`, which requires a session cookie and a CSRF
token. After discovery + approval, this is the tool the agent sees:

```json
{
  "name": "browser.create_task",
  "description": "Create task on 127.0.0.1 via POST /api/tasks. Observed 2 times while discovery was running.",
  "inputs": {
    "type": "object",
    "properties": {
      "title":       { "type": "string" },
      "description": { "type": "string" },
      "priority":    { "type": "number" }
    },
    "required": [],
    "additionalProperties": false
  },
  "outputs": {
    "type": "object",
    "properties": { "task": { "type": "object", "additionalProperties": true }, "created": { "type": "boolean" } }
  },
  "tags": ["127.0.0.1", "write"],
  "tool_call_template": {
    "call_template_type": "utcp_browser_session",
    "runtime_url": "http://127.0.0.1:8777",
    "pairing_token": "${UTCP_BROWSER_SESSION_TOKEN}",
    "tool": "browser.create_task",
    "method": "POST",
    "path_template": "/api/tasks",
    "param_locations": { "title": "body", "description": "body", "priority": "body" },
    "permission": "WRITE",
    "timeout_ms": 30000
  }
}
```

Note what is *not* in there: no cookie, no token, no session id. The only
credential reference is the `${UTCP_BROWSER_SESSION_TOKEN}` variable, resolved by
the official SDK from the client's variables at call time.

## Security

The full model is in [`docs/security.md`](docs/security.md). The short version:

- **The credential never leaves the browser.** The extension has no `cookies`
  permission and no code path that reads `document.cookie`. Chrome attaches the
  session cookie to the request; the runtime only ever sees status, allowlisted
  headers and a body.
- **Pairing is a key exchange, not a shared secret.** ECDSA P-256, per-socket
  nonce, 60 s clock skew, single use. The runtime stores only the public key.
- **Exact domain allowlist.** Hostname plus pinned origin, validated again at
  execution time. No wildcards, no suffixes, no cross-domain, no scheme swap.
- **Nothing executes without approval.** Drafts are invisible to manuals and
  refused by the executor; disabling a domain revokes its tools.
- **Destructive needs two keys.** Classified `DESTRUCTIVE` and refused unless the
  caller passes `__confirm: true`.
- **Redirects are refused, not followed.** `redirect: 'manual'` means an opaque
  redirect is reported as `redirect_blocked`.
- **Everything is redacted.** Logs, audit events, execution previews and generated
  manuals pass through a redactor that masks bearer tokens, JWTs, cookie pairs
  and secret-named fields. Tests scan the state file and the audit log for
  injected secrets.
- **No stealth, no bypass.** CAPTCHA, MFA, bot detection and site authorisation
  are out of scope, permanently.

What it does **not** protect against: an attacker who can already read your
browser profile or the runtime data directory. At that point the browser itself
is compromised.

## Compatibility

| | |
| --- | --- |
| Browser | Chrome / Chromium ≥ 116 (MV3). Not Firefox, not mobile. |
| Works when | same-origin JSON API, cookie auth (HttpOnly is fine), CSRF token fetchable with the session cookie, no same-origin `Origin` requirement |
| Discovered but not executable | GraphQL operations (the query document is never recorded), multipart uploads, streaming responses, binary downloads — they appear in the inventory with the reason, and never become tools |
| Does not work | cross-origin API hosts, `localStorage` bearer tokens, sites that reject `chrome-extension://` origins, strict CSP that blocks the tap (degrades to method/path only), GraphQL-only APIs, streaming, WebSockets |
| Never | cookie export, `Origin` spoofing, CAPTCHA/bot-detection bypass, acting as a proxy |

Details and the full table: [`docs/limitations.md`](docs/limitations.md).

## Documentation

| Document | Contents |
| --- | --- |
| [`docs/architecture.md`](docs/architecture.md) | Components, sequence diagrams, data model, design decisions |
| [`docs/security.md`](docs/security.md) | Threat model, controls, audited events, residual risks |
| [`docs/testing.md`](docs/testing.md) | What each suite proves and how to run it |
| [`docs/performance.md`](docs/performance.md) | Benchmark method and measured overhead |
| [`docs/limitations.md`](docs/limitations.md) | Every known constraint, including unsupported sites |
| [`docs/competitive-analysis.md`](docs/competitive-analysis.md) | Honest comparison with browser-session MCP, Web-API_Extension, Playwright MCP |
| [`docs/audit-report.md`](docs/audit-report.md) | Architecture and security audit: findings by severity, root cause, fix, evidence |
| [`docs/acceptance-report.md`](docs/acceptance-report.md) | AC-01…AC-19 with commands, expected/actual results and evidence |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Setup, conventions, how to add a capability |
| [`SECURITY.md`](SECURITY.md) | How to report a vulnerability |

## Development

```bash
npm run typecheck        # tsc, strict, whole repo
npm run lint             # consistency rules (console use, escape hatches, secrets)
npm test                 # 110 unit + integration + security tests
npm run test:e2e         # 13 Playwright tests in real Chromium (use xvfb-run on a server)
npm run bench            # performance comparison, writes docs/performance.json
npm run build            # dashboard + extension
npm run screenshots      # regenerate docs/screenshots and the demo GIF
```

```
packages/shared     policy, schema inference, redaction, wire protocol (no I/O)
packages/provider   @utcp/sdk transport plugin
packages/runtime    HTTP + WebSocket server, approvals, audit, execution
packages/test-site  deterministic fixture website
extension           MV3: service worker, page tap, popup
dashboard           React + MUI dashboard served by the runtime
tests               unit · integration · security · e2e · bench
```

Measured on this repository's CI-sized machine: 123 tests pass, the E2E suite
runs in ~20 s, and the UTCP stack adds roughly **20 ms p50** on loopback over a
direct browser `fetch` (see [`docs/performance.md`](docs/performance.md)).

## Roadmap

**Implemented**

- Extension pairing, signed handshake, reconnection, unpair
- Domain allowlist with pinned origin, enable/disable from dashboard and popup
- Discovery: `webRequest` inventory + opt-in structural schema capture
- Draft generation, approval, rename, revoke, delete
- UTCP manual generation validated by the official SDK
- Execution with argument validation, permissions, confirmation, rate limits,
  timeouts, truncation, redirect blocking
- Dashboard: overview, websites, tools, workflows, executions, security, settings
- Fixture site, unit + integration + security + E2E suites, benchmark, CI
- Per-origin isolation, domain policy ceilings, bounded concurrency, cancellation
- Multi-observation schema inference (required / optional / nullable / enums),
  pagination and operation-kind classification, confidence scoring
- Correlation ids, metrics endpoint, hash-chained audit log
- Workflow proposals from execution history (review only)

**In progress**

- Richer GraphQL support: the operation *name* is classified today, but the
  query document is deliberately not recorded, so those tools stay non-executable
  until the user supplies a query template in the dashboard
- A second browser profile per runtime (today: one extension connection)

**Planned**

- Firefox port (MV3 differences are non-trivial; no date)
- Optional `chrome.debugger` mode for response bodies on sites where the page tap
  is blocked by CSP — behind an explicit, documented permission prompt
- Import/export of approved tool sets between machines
- Per-origin rate limits (today the limit is per tool, plus a global in-flight cap)

Nothing in *Planned* exists in the code today. If you need one of these, open an
issue rather than assuming it works.

## License

MIT — see [`LICENSE`](LICENSE).

Built on the official
[UTCP specification](https://github.com/universal-tool-calling-protocol/utcp-specification)
and the [TypeScript SDK](https://github.com/universal-tool-calling-protocol/typescript-utcp)
(MPL-2.0). The comparison in `docs/competitive-analysis.md` discusses other
projects' licences; no code from them is used here.
