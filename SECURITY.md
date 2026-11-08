# Security policy

## Reporting a vulnerability

Open a private security advisory on GitHub
(`Security → Advisories → Report a vulnerability`) or email the maintainer
listed in `package.json`. Please do not open a public issue for anything that
could let a third party reach a user's browser session.

Expect an acknowledgement within 72 hours. If the report is valid we will ship a
fix and credit you unless you ask us not to.

## Scope

In scope:

- Bypassing the domain allowlist, the approval state, or the destructive
  confirmation.
- Getting a credential (cookie, authorization header, CSRF token) into a log,
  a tool response, a generated manual or the state file.
- Impersonating a paired extension to the runtime, or a runtime to the extension.
- Turning the runtime into an HTTP proxy or an SSRF primitive.
- Executing a tool that was never approved.

Out of scope (documented in `docs/security.md`):

- An attacker who can already read the user's browser profile or the runtime
  data directory. Both are local files owned by the user; the threat model stops
  at a compromised local account.
- Websites that reject `chrome-extension://` origins outright. That is the
  site's own policy and no extension can satisfy it.
- Reading a website's HttpOnly cookie. That is the point of the design.

## Supported versions

This is a pre-1.0 project. Only the latest commit on `main` receives fixes.

## Dependency advisories

`npm audit` reports a known advisory in `zod` (`GHSA-mrhx-c7xc-m3w5`, memory
exhaustion while validating oversized constrained collections) pulled in by
`@utcp/sdk`. No fixed 3.x release exists. Mitigations in place:

- every websocket frame is capped at 512 KiB before parsing,
- every REST body is capped at 1 MiB,
- discovery arrays are capped (200 events per frame, 64 query keys, 64 schema
  properties, depth 6).

Re-evaluate when `@utcp/sdk` moves to zod 4.
