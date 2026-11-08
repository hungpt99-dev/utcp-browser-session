# Contributing

Thanks for taking the time to look at this project.

## Ground rules

1. **Security first.** A change that makes a request easier to send, or a
   credential easier to read, needs to explain why it is safe in the pull
   request. Reviews default to "no" for anything that widens the credential or
   domain boundary.
2. **No fake success.** Tests must exercise real behaviour. If something cannot
   be tested in this environment, say so in the test file and in
   `docs/limitations.md` instead of asserting a mock returned the right string.
3. **Evidence over adjectives.** If you claim a feature works, include the
   command and the output that show it.

## Development setup

```bash
git clone https://github.com/hungpt99-dev/utcp-browser-session.git
cd utcp-browser-session
npm install
npm run build          # dashboard + extension
npm run typecheck
npm run lint
npm test               # unit + integration + security
npm run test:e2e       # real Chromium with the unpacked extension (needs a display; use xvfb-run on a server)
```

On a headless Linux box the E2E suite needs a virtual display:

```bash
xvfb-run -a npm run test:e2e
```

## Project layout

| Path | What lives there |
| --- | --- |
| `packages/shared` | Policy, schema inference, redaction, wire protocol. No I/O, imported by both sides. |
| `packages/provider` | The UTCP transport plugin for `@utcp/sdk`. |
| `packages/runtime` | HTTP + websocket server, approvals, audit, execution pipeline. |
| `packages/test-site` | Deterministic fixture website used by every test. |
| `extension` | Manifest V3 extension (service worker, page tap, popup). |
| `dashboard` | React + MUI dashboard served by the runtime. |
| `tests` | Unit, integration, security, E2E and benchmark suites. |

## Adding a discovered-endpoint capability

1. Add the field to `EndpointObservationSchema` in `packages/shared/src/protocol.ts`.
2. Merge it in `Store.recordObservation`.
3. Surface it in `buildInputSchema` (if it affects tool inputs).
4. Add a unit test for the pure part and an integration test through the fake
   extension (`tests/helpers/fake-extension.ts`).
5. If the extension observes it, update `extension/src/lib/discovery.ts` and the
   E2E assertion in `tests/e2e/acceptance.spec.ts` (AC-03).

## Commit style

Conventional commits, scoped by package:

```
feat(provider): expose tool permission in the manual tags
fix(runtime): reject absolute URLs smuggled into path parameters
test(e2e): cover session expiry without a fallback request
docs(readme): correct the dashboard bootstrap URL
```

## Pull requests

- Keep the diff focused. Unrelated refactors belong in their own PR.
- Run the full gate before opening: `npm run typecheck && npm run lint && npm test && npm run build && xvfb-run -a npm run test:e2e`.
- Never commit `.data/`, browser profiles, `state.json` or any token file —
  `.gitignore` covers them, but check `git status` anyway.
- Do not add a dependency without justifying it in the PR description. The
  runtime has four: `ws`, `zod`, and the official `@utcp/sdk` (plus its own
  `dotenv`).
