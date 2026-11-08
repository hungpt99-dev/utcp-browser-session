# Security model

This document is the contract. If the code and this document disagree, that is a
bug — please report it.

## Boundary diagram

```mermaid
flowchart TB
    subgraph Browser["Browser (holds the credential)"]
        CK[("HttpOnly cookie<br/>never readable by JS")]
        SW["Extension service worker<br/>no cookies permission"]
        CK -.->|"attached by Chrome at the network layer"| SW
    end

    subgraph Runtime["Local runtime (no credential)"]
        T["Bearer token<br/>0600 file"]
        ST[("state.json<br/>no cookies, no auth headers")]
        AU["audit log<br/>redacted"]
    end

    subgraph Client["UTCP client"]
        CL["tool arguments and results only"]
    end

    SW -->|"status, headers (filtered), body"| Runtime
    Runtime --> CL
    Runtime --- T
    Runtime --- ST
    Runtime --- AU
```

## Assets

| Asset | Where it lives | Who can read it |
| --- | --- | --- |
| Website session cookie | Browser cookie jar (HttpOnly) | Chrome only. Never extension JS, never the runtime |
| Website CSRF token | Fetched on demand into a local variable | Extension, for the duration of one request |
| Runtime bearer token | `~/.utcp-browser-session/runtime-token` (0600) | The user's account |
| Pairing private key | `chrome.storage.local` in the extension | The extension, that Chrome profile |
| Pairing public key | `state.json` | The user's account |
| Approvals, audit, executions | `state.json` (0600), redacted | The user's account |
| Tool results | Client memory, execution preview (redacted) | The client, the dashboard |

## Threat model

**In scope.** A malicious or buggy *website* that answers a tool call; a
malicious *page* that tries to influence discovery; a *network* attacker on
localhost; a *third-party process* that can make HTTP requests but not read the
user's files; a *UTCP client* (an AI agent) that calls tools with hostile
arguments.

**Out of scope.** An attacker who can read the user's browser profile, the
runtime data directory, or run code as the user. Once that is true, the browser
and the runtime are both compromised. Also out of scope: a site's own
authorisation decisions, and CAPTCHA/bot-detection arms races.

## Controls

### Two credentials, and why

The runtime issues two different tokens, because the agent and the human must not
share one:

| Credential | File | Holder | Can do |
| --- | --- | --- | --- |
| admin | `runtime-token` | you, the dashboard, the CLI | everything: domains, approvals, policy, pairing, settings, audit |
| execute | `agent-token` | the UTCP manual / provider | `POST /api/v1/execute`, `GET /api/v1/status`, `GET /api/v1/manual`, `GET /api/v1/manual/validate` |

Everything else answers `403 policy_blocked` for the execute credential. This is
what makes "a human approves before anything runs" true: the credential an agent
holds cannot approve a tool, enable a domain, rename a tool or mint a pairing
code. The provider additionally pins the runtime origin, so a manual cannot
redirect that credential to another destination.

### Authentication between components

- **Extension ↔ runtime.** The extension generates an ECDSA P-256 key pair once.
  At pairing it sends the public half; the runtime stores only that. Every
  websocket connection starts with a fresh 24-byte nonce; the extension signs
  `${clientId}:${nonce}`; the runtime verifies with the stored public key and
  rejects a timestamp older than 60 s. The nonce is per-socket and single-use, so
  a captured handshake cannot be replayed.
- **Client ↔ runtime.** A 32-byte bearer token, generated on first start and
  stored with mode 0600. Compared in constant time. Every `/api/*` route
  requires it except `/api/v1/pair/claim`.
- **Pairing code.** 8 characters from a 32-symbol alphabet (no `0/O/1/I`), single
  use, 5-minute TTL, minted only by an authenticated dashboard action. Claims
  must present a valid `chrome-extension://` origin and an `extensionId` that
  matches it.

### Domain and URL policy

Enforced on both sides of the websocket:

1. The tool's domain must be enabled (`enabled: true`) at call time.
2. The URL must parse, be `http(s)`, carry no credentials, contain no control
   characters, backslashes or encoded CR/LF, and be ≤ 2048 bytes.
3. `url.hostname` must equal the tool's domain exactly — no suffix matching, no
   wildcards.
4. When the domain has a recorded `origin`, `url.origin` must equal it exactly
   (scheme + host + **port**), which is what stops a fixture on `:8788` from
   being reachable at `:9999`.
5. `http:` is only allowed for loopback; public hosts must use `https:`.
6. Private address literals (`10/8`, `172.16/12`, `192.168/16`, `169.254/16`,
   `100.64/10`, `127/8` other than loopback) are refused before any request.
7. Redirects are never followed blindly. The extension uses
   `redirect: 'manual'`; an opaque redirect is reported as `redirect_blocked`.
   If a real `3xx` with a `Location` ever arrives, the runtime validates the
   destination against the same domain/origin rules and caps the chain at 2.

Argument values cannot change the host: path parameters are
`encodeURIComponent`-escaped into their segment, and query parameters are built
with `URLSearchParams`. A test asserts that `id: "http://169.254.169.254/…"`
stays inside the path.

### Approvals and permissions

- Every generated tool starts as `draft`. A draft is invisible to the manual and
  refused by the executor.
- `approved` requires an authenticated action and an enabled domain.
- Disabling a domain revokes its tools.
- `revoked` tools are refused and never appear in a manual.
- **Classification is evidence-based, never method-only.** The path is split into
  segments and checked for a destructive verb (`delete`, `destroy`, `remove`,
  `purge`, `drop`, `revoke`, `terminate`, `wipe`, `reset`, `archive`,
  `deactivate`, `suspend`, `unlink`, `detach`), a read verb (`get`, `list`,
  `search`, `query`, …) or a write verb (`create`, `update`, `approve`, …);
  GraphQL operations are classified by their operation name; an observed body and
  the response shape contribute. The method only corroborates. Consequences:
  `GET /tasks/1/delete` is **DESTRUCTIVE**, `POST /search` with a body is
  **READ**, `GET /api/tasks` is **READ**. Anything unrecognised stays `WRITE`
  **and** `reviewRequired`.
- **The permission used at execution is the stored one**, clamped by the domain
  policy — never recomputed at call time from the method, so a caller cannot
  argue its way past a reviewed classification.
- **A domain ceiling** (`READ` / `WRITE` / `DESTRUCTIVE`) and optional
  `confirmWrites` are enforced before dispatch. A tool above the ceiling is
  refused with `policy_blocked`; it is *not* silently relabelled (a WRITE
  relabelled READ would still mutate the site while claiming to be safe).
- `blockedPathPrefixes` keeps whole areas (`/admin`) out of draft generation.
- **Path parameters are single segments.** `.`, `..`, any slash, backslash or
  percent-encoded equivalent is refused as `invalid_arguments` — otherwise URL
  normalisation would let `/api/tasks/{id}` be aimed at a sibling endpoint that
  was never discovered.
- **Revoking a browser disconnects it.** The live socket is closed with 4003 and
  its pending calls are rejected; revocation is not deferred to the next
  reconnect.
- `DESTRUCTIVE` requires `__confirm: true` on the call. The flag is stripped
  before the request is built, so it can never reach a website.
- **Nobody can change policy through the manual.** Tools only execute; policy
  mutation requires the runtime bearer token and is not part of the UTCP surface.

### Request and response limits

| Limit | Value | Enforced by |
| --- | --- | --- |
| Request body | 256 KiB | Runtime (before dispatch) |
| Response body | 1 MiB (configurable, max 8 MiB) | Extension + runtime (truncate + flag) |
| Websocket frame | 512 KiB | `ws` `maxPayload` + explicit check |
| REST body | 1 MiB | Runtime |
| Timeout | 30 s default (1–120 s) | Extension `AbortController` + runtime timer |
| Redirects | 2 | Runtime |
| Rate | 60 calls/min/tool (configurable ≤ 600) | Runtime sliding window |
| Concurrency | 8 in flight (1–32) | Runtime semaphore |
| Queue | 32 waiting calls, then `busy` | Runtime bounded queue |
| Cancellation | on client disconnect | HTTP `close` → `cancel` frame → extension `abort` |
| Response frame | one frame | body capped below `maxMessageBytes`, streamed and cancelled at the cap |
| CSRF bootstrap | 5 s, 64 KiB | extension `AbortController` + content-length check |

### Credential hygiene

- **Redaction happens at the persistence boundary**, not at each call site:
  audit messages and details, the stored request path (query strings) and error
  messages are redacted before they reach disk.
- The extension requests **no** `cookies` permission. There is no code path that
  reads `document.cookie`, `chrome.cookies`, or a request's `Cookie` header.
- The runtime's result envelope includes only an allowlist of response headers:
  `content-type`, `content-length`, `etag`, `x-request-id`, `retry-after`.
  `set-cookie` and `authorization` are dropped, not redacted.
- Everything written to `state.json`, the audit log, execution previews and the
  logger passes through `redactValue`, which masks known secret header names,
  `Bearer`/`Basic` credentials, JWTs, ≥40-character token-shaped strings and
  `name=value` cookie pairs.
- Generated manuals contain `${UTCP_BROWSER_SESSION_TOKEN}`, never a literal.
  `validateManualDocument` refuses a manual that contains credential material or
  a literal token.
- Response bodies are **not** stored in full: the execution record keeps a
  1500-byte redacted preview.

### Local communication

- The runtime binds `127.0.0.1` by default. Binding elsewhere is possible but
  prints no warning — the token is then your only control, so don't.
- Dashboard CORS headers are emitted only for `chrome-extension://` origins, and
  only on the pairing route.
- The websocket upgrade requires a `chrome-extension://` origin that matches the
  paired client's extension id.
- The runtime is **not** a proxy: there is no route that forwards an arbitrary
  URL. The only path to a website is an approved tool on an enabled domain.

## Audited events

`tool.executed`, `tool.rejected`, `tool.failed`, `tool.approved`, `tool.revoked`,
`tools.generated`, `domain.enabled`, `domain.disabled`, `discovery.started`,
`discovery.stopped`, `pair.code_created`, `pair.claimed`, `pair.claim_rejected`,
`extension.connected`, `extension.disconnected`, `extension.handshake_rejected`,
`request.redirect_blocked`.

Each event stores: timestamp, kind, severity, actor, origin, tool name,
correlation id, a short message and a redacted detail object. A security test
scans the whole audit log for the injected secrets.

**Tamper evidence.** Every event hashes `prevHash` plus its own fields
(SHA-256), forming a chain that survives restarts (the head is stored in the
state document). `GET /api/v1/audit/verify` recomputes the chain over the events
on disk and names the first entry that does not match. Editing or reordering the
log is therefore visible — it does not prevent a local attacker from deleting the
whole file, which is documented below.

## Residual risks

1. **A compromised local account is game over.** Anyone who can read the browser
   profile can use the session directly; anyone who can read
   `~/.utcp-browser-session` can drive a paired browser.
2. **A fake runtime on the same port** could ask the extension to sign arbitrary
   nonces (not the private key) and then request executions for enabled domains.
   This requires the attacker to already run code as the user. The extension
   refuses non-loopback runtime URLs, which limits the blast radius.
3. **Schema inference is structural.** A field is only marked `required` when
   every observation carried it, and nothing is required from a single sample,
   but a site with unstable responses can still produce a schema that is too
   narrow for a rare payload. Tools stay drafts until a human checks the shape,
   and low-confidence tools are flagged `reviewRequired`.
4. **`Origin` is attacker-controlled by the page, not by the extension.** An
   extension-originated POST carries `Origin: chrome-extension://…`; a site that
   requires a same-origin `Origin` cannot be called at all (see limitations).
5. **CSRF tokens are fetched on demand.** If a site rotates tokens per request or
   binds them to a nonce the extension cannot see, writes will fail with the
   site's own error. Nothing is bypassed.
6. **Zod advisory.** See `SECURITY.md`; mitigated by hard size caps.
7. **The audit log is tamper-*evident*, not tamper-proof.** A local attacker who
   can write `~/.utcp-browser-session` can delete the log or forge a consistent
   chain from scratch. Ship the log elsewhere if you need assurance against that.
8. **The extension is the trust boundary.** Any code that can drive the paired
   extension can act as the user on the origins it was granted. That is why the
   allowlist is explicit, per-origin and revocable, and why every execution is
   audited with a correlation id.
