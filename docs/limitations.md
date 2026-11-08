# Limitations

Everything here is a known, accepted constraint. If a limitation blocks you,
that is useful feedback — open an issue describing the site and the request that
failed.

## Browser support

- **Chrome and Chromium only.** The extension uses MV3, `world: "MAIN"` content
  scripts (Chrome 111+) and the current `fetch` behaviour of extension service
  workers. Firefox's MV3 implementation differs enough that this build will not
  load.
- **Desktop only.** The popup and the page tap assume a normal tab. There is no
  mobile browser support.
- **Not published to the Chrome Web Store.** Load it unpacked. A store listing
  would need a review of the `webRequest` and optional-host-permission usage.

## Website compatibility

Support is deliberately narrow. A site works when all of these hold:

1. The API you want is on the **same origin** as the page you are signed in to.
2. The API is called with `fetch`/`XMLHttpRequest` and returns **JSON**.
3. Authentication is a **cookie** that Chrome attaches automatically (including
   HttpOnly cookies — those are the good case).
4. Any CSRF protection can be satisfied by a token that is **fetchable** with the
   session cookie (see below), or is not required for the operation.
5. The site does not require a **same-origin `Origin` header**.

Known unsupported cases:

| Case | Why |
| --- | --- |
| API on a different host (`api.example.com` from `app.example.com`) | Cross-domain by design. Enable the API host as its own domain and call it there — but the session cookie may not be sent cross-site |
| Bearer tokens held in `localStorage` by the site | The extension has no access to page storage, and reading it would be credential extraction |
| Sites that reject `chrome-extension://` origins | The `Origin` header cannot be changed by an extension. No workaround exists, by design |
| Strict Content-Security-Policy blocking injected scripts | The page tap cannot instrument `fetch`; discovery degrades to method/path/status only |
| GraphQL over a single POST endpoint | Discovery sees one endpoint; request bodies differ per query, so schema inference is not meaningful |
| Server-rendered forms / multipart uploads | No JSON body to infer, no parameters to model |
| Streaming / SSE responses | The extension reads a complete body |
| WebSocket-based APIs | Not observed and not replayable |
| Sites behind bot detection that fingerprints extensions | Not bypassed, deliberately |

## Discovery

- **`webRequest` cannot see bodies in MV3.** Method, path, query names, status and
  content type are available; request and response bodies are not. That is why
  schema capture needs the opt-in page tap.
- **The page tap only sees `fetch` and `XMLHttpRequest`** issued after it loads,
  in the top frame (`all_frames: false`). Requests from workers or iframes are
  missed.
- **Schema inference is structural and shallow**: depth 5, 40 properties per
  object, first array element only. Widened types (`["string","number"]`) and
  missing `required` fields are normal.
- **Query parameter types are unknown.** They are modelled as strings and coerced
  at call time.
- **Discovery is noisy.** Analytics beacons, CSRF bootstraps and health checks are
  recorded like anything else. Review before approving; delete what you don't
  want.
- **Nothing is captured while discovery is stopped**, and nothing at all for
  domains that are not enabled — but while it is running, any XHR the page makes
  to that domain is recorded (metadata only).

## Execution

- **No response streaming.** A tool call returns one complete body.
- **Redirects are refused.** `redirect: 'manual'` returns an opaque response
  whose `Location` header extension code cannot read, so the extension reports
  `redirect_blocked`. The runtime has validation code for a real `3xx`, but a
  normal browser will not produce one.
- **CSRF must be explicitly configured.** For a site that needs a token, set
  `csrf: { bootstrapPath, tokenField, header }` on the domain. The extension
  fetches that JSON endpoint with the session cookie before each write. Sites
  that rotate tokens per request, bind them to a nonce, or require a
  double-submit cookie the extension cannot read will fail — with the site's own
  error, never by bypassing it.
- **Rate limit** is 60 calls/minute/tool by default and is per runtime process.
- **Timeouts** are 30 s by default; the extension aborts, the runtime records a
  `timeout`.
- **One browser, one runtime.** Pairing a second profile replaces the connection;
  there is no multi-tenant routing.

## Schema assumptions

- The generated input schema treats path parameters as required strings and
  everything else as optional. A required body field that the site only enforces
  server-side will surface as the site's 4xx, not as a client-side validation
  error.
- `additionalProperties: false` on inputs means an agent cannot send a field that
  was never observed. Fields that appear only in untested code paths must be
  added by regenerating the tool from a run that exercises them.

## Operational

- **Single-user, local-only.** No authentication beyond the runtime token, no
  multi-user model, no remote deployment story. Binding the runtime to `0.0.0.0`
  turns the token into the only control.
- **State is a JSON file.** Fine for thousands of records; every write rewrites
  the document.
- **Dashboard settings apply immediately** except the rate-limit window, which
  keeps its in-memory counters.
- **The runtime must be running** for the provider to register a manual; the
  provider does not cache.

## What still needs a human

Even after `up`, these are deliberate:

1. **Signing in.** The product's premise is *your* session. A login is never
   scripted; `up --demo` only gives you a known account on a local fixture.
2. **Approving.** Drafts are generated automatically in demo mode, but nothing
   becomes callable until a person presses Approve. This is a credential
   boundary (the agent holds the execute-only token), not a UI convention.
3. **`__confirm` for destructive tools.** The caller has to pass it; the runtime
   will not infer consent from a tool's name.
4. **Enabling a site you care about.** `--demo` enables the fixture. Any real site
   is enabled by you, with its exact origin; `up` does not guess.

The first-run E2E (`tests/e2e/first-run.spec.ts`) performs exactly steps 1 and 2
programmatically and nothing else.

## Known gaps in this revision

- **GraphQL is classified but not executable.** The tap records the operation
  name and the envelope shape, never the query document, so a generated tool
  could not replay the call. Those endpoints appear in the inventory with
  `kind: graphql` and are skipped by draft generation with the reason shown.
- **Uploads and streams are not executable.** Multipart bodies and `text/event-stream`
  bodies cannot be replayed faithfully through this transport; they are
  discovered, classified and skipped.
- **Cookies are host-scoped, not origin-scoped.** Two applications on the same
  host share a cookie jar when they use the same cookie name and path; the
  browser will overwrite one with the other. The runtime keeps the two *origins*
  isolated, but the website's own cookie rules still apply. Different hostnames
  (including `localhost` vs `127.0.0.1`) have separate jars.
- **One browser profile per runtime.** A second Chrome profile needs a second
  runtime (different `UBS_DATA_DIR` and port).
- **Per-tool rate limits only.** There is no per-origin quota; the global
  in-flight cap is the coarse protection.
- **MV3 can still suspend the worker mid-burst.** Loopback listeners are
  registered synchronously (so Chrome wakes the worker) and `onSuspend` flushes,
  but an observation that arrives between the last flush and the teardown can be
  lost. The next `sync` re-establishes capture state.
- **`reviewRequired` is advisory.** It flags thin evidence in the dashboard; the
  person clicking Approve is the review. It is not a second confirmation step.
- **Audit `actor` is client-asserted.** A caller with the admin token can label
  its request `dashboard` or `cli`; the value is informational, not proof of
  origin. Correlation ids and the credential scope are the trustworthy parts.

## Things this project will not do

- Export cookies or session tokens, to any client, in any format.
- Read `localStorage`/`sessionStorage` to recover a bearer token.
- Bypass CAPTCHA, MFA, bot detection or a site's authorisation.
- Spoof `Origin`, `Referer`, User-Agent or TLS fingerprints.
- Act as a general HTTP proxy.
- Claim universal website compatibility. The supported shape is: same-origin,
  cookie-authenticated JSON APIs on a site you are signed in to.
