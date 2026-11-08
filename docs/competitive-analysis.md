# Competitive analysis

*Point-in-time review: November 2026. Sources are linked; everything claimed
about another project was read from its repository or README at that date.*

## Why this document exists

"Browser sessions as tools" is not an empty space. Before writing code we looked
at what already exists, what each project optimises for, and what is genuinely
missing. The short version: browser-automation agents and one SaaS-specific
extension already cover parts of the problem, but none of them is a **UTCP
transport** with a **discovery → human approval → execution** pipeline that
leaves the credential in the browser.

## The neighbours

### 1. `browser-session-mcp` (xav-ie)

An MCP server that hands each agent a long-lived, isolated Chrome session. It
runs Chrome with the DevTools protocol on port 9222, keeps sessions as separate
browser contexts, records console/network activity per page visit, supports
human "takeover" for logins, and can save/load browser state by name. It also
offers stealth controls (no `Runtime.enable` tell, consistent UA/client hints).

- **Transport:** MCP only.
- **Credential model:** cookies live in the controlled Chrome profile and can be
  *exported* to named state files (`save_browser_state`), which the project
  treats as a feature.
- **Discovery:** no tool generation — the agent drives 39 fixed tools.
- **Deployment:** a separate browser process plus an MCP server binary.

### 2. V-You `Web-API_Extension`

A Chrome extension that exposes a SaaS HTTP API to WebMCP-compatible agents,
with UTCP for orchestration and "code mode" for local script execution. It binds
to the active SaaS tab, executes from the extension to reuse the dashboard
session, and shows a large context-window reduction versus a legacy MCP server.

- **Transport:** WebMCP (in-browser) with UTCP for orchestration — not a UTCP
  transport plugin.
- **Scope:** one vendor family (`oppwa.com` and its whitelabels), driven by
  hand-curated OpenAPI metadata (including a "tier B" set of ~627 settings that
  lack full type information).
- **Credential model:** the extension holds Web API credentials (encrypted in
  `chrome.storage`) and a PIN, not the site's existing session cookie.
- **Licence:** CC BY-NC-SA 4.0 — non-commercial without a paid licence.
- **Requires:** Chrome 146+ with the `#enable-webmcp-testing` flag.

### 3. Official UTCP SDKs and specification

`python-utcp` and `typescript-utcp` define the protocol (`UtcpManual`, `Tool`,
`CallTemplate`) and ship transports for HTTP, CLI, WebSocket, text and MCP. The
plugin architecture (`CommunicationProtocol` + `CallTemplateSerializer`) is
explicitly designed for new transports — but the shipped set has no
browser-session transport.

### 4. Playwright / Puppeteer MCP servers

Excellent for deterministic automation of a browser *you control*. They launch
their own browser, so they do not carry the user's existing logins, and they
model the web as a page to drive rather than an API to call. Two consequences:
the agent must re-authenticate, and every call pays DOM-interaction cost.

### 5. Manual integrations (PATs, OAuth apps, per-service MCP servers)

The status quo this project is arguing against: one integration, one credential,
one OAuth consent screen per service. It works, it is auditable, and it does not
scale to "the long tail of internal tools a team already has open in a tab".

## Comparison matrix

| Capability | UTCP Browser Session | browser-session-mcp | V-You Web-API_Extension | Playwright/Puppeteer MCP | Per-service MCP servers |
| --- | --- | --- | --- | --- | --- |
| Native UTCP transport plugin | **Yes** (`utcp_browser_session`) | No (MCP) | Partial (UTCP for orchestration) | No (MCP) | No (MCP/HTTP) |
| Reuses the user's existing session | **Yes** | Yes (its own Chrome profile) | Yes (active SaaS tab) | No | No |
| Credential stays inside the browser | **Yes** — cookies never readable by extension code | No — state export is a feature | No — credentials stored in the extension | No — automation profile | No — token store |
| Credential-free generated manual | **Yes** — `${UTCP_BROWSER_SESSION_TOKEN}` only | n/a | n/a | n/a | n/a |
| Discovers a site's API automatically | **Yes** (webRequest + opt-in page tap) | No | Partial (curated OpenAPI) | No | No |
| Human review before a tool exists | **Yes** (draft → approve → revoke) | n/a (fixed tools) | No (pre-published tools) | n/a | n/a |
| Domain allowlist, exact hostname | **Yes** (+ pinned origin) | Session-scoped | Vendor domains | No | Per-credential |
| Permission levels READ/WRITE/DESTRUCTIVE | **Yes** | n/a | Mostly read/write | n/a | Varies |
| One local server for every website | **Yes** | Yes | Yes (single vendor) | Yes | No (one per service) |
| Stealth / anti-bot measures | **No, deliberately** | Yes | No | Optional | n/a |
| Works with logged-in sites that block extensions | No | Yes (own browser) | No | Yes | n/a |
| Licence | MIT | MIT | CC BY-NC-SA | Apache-2.0 | Varies |

## Where this project is deliberately different

1. **It is a UTCP transport, not an MCP server.** The provider implements
   `CommunicationProtocol`, registers a `CallTemplateSerializer`, and produces
   manuals that `UtcpManualSchema` accepts. Any UTCP client (the official TS
   SDK, or a Python client with the same transport) can call it.
2. **Discovery is the product, not a fixed tool list.** Instead of 39 browser
   tools, the user gets tools *for the API they already use*, generated from
   observed traffic and reviewed before they exist.
3. **The credential boundary is the browser.** We do not save cookies, we do not
   expose a cookies API, and the extension has no `cookies` permission. Chrome
   attaches the session at the network layer; extension JavaScript never sees it.
   `browser-session-mcp` takes the opposite (defensible) trade-off because it
   needs portability across sessions.
4. **Approval is a first-class state machine.** `draft → approved → revoked`,
   with destructive operations needing a second, explicit confirmation at call
   time.
5. **No stealth, no bypass.** If a site's bot detection blocks an extension, the
   site wins. That is a product boundary, documented in `limitations.md`.

## Where the neighbours are better

- `browser-session-mcp` works on sites that refuse extensions entirely, because
  it drives its own Chrome. It also supports multiple concurrent agent sessions
  with isolated state; this project is one browser profile, one runtime.
- Web-API_Extension has hand-curated, deeply typed API metadata for its vendor,
  which is far richer than anything schema inference can produce.
- Playwright MCP is the right tool for "click through a flow"; this project is
  for "call the API behind the flow".

## What we could not verify

Claims in other READMEs about performance (e.g. ">90% context reduction") were
not reproduced here; we did not benchmark other projects. The comparison above
is architectural, not a bake-off. If you are choosing between them, run both on
your own site.
