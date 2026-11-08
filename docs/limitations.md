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

## Things this project will not do

- Export cookies or session tokens, to any client, in any format.
- Read `localStorage`/`sessionStorage` to recover a bearer token.
- Bypass CAPTCHA, MFA, bot detection or a site's authorisation.
- Spoof `Origin`, `Referer`, User-Agent or TLS fingerprints.
- Act as a general HTTP proxy.
- Claim universal website compatibility. The supported shape is: same-origin,
  cookie-authenticated JSON APIs on a site you are signed in to.
