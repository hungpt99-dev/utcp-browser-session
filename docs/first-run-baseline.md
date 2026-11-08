# First-run baseline (Phase 0)

Measured on a clean clone of `67c6bec` on this box, before any of the work in
this change set. Every number below comes from a scripted run of the README quick
start, not from estimate.

Environment: Ubuntu 24.04.5, kernel 6.8.0-147-generic, AMD EPYC (6 vCPU), Node
24.22.1, Chromium 158 via Playwright, `xvfb-run -a` (headless, no display).

## What was run

```
git clone          2 019 ms
npm install       79 830 ms   (warm-ish npm cache, esbuild postinstall warning)
npm run build     18 696 ms
README steps 4–8  ≈ 18 600 ms scripted (see table)
```

Scripted timings, fresh `UBS_DATA_DIR` (so this is a genuine first run):

| Step (README) | ms |
| --- | --- |
| 4–5. `npm run site`, `npm run runtime` | 742 |
| 6. load unpacked into Chrome (scripted equivalent of `chrome://extensions`) | 910 |
| 7a. `npm run pair` prints a one-time code | 562 |
| 7b. paste runtime URL + code into the popup, click Pair | 1 197 |
| 8a. dashboard: site URL + CSRF path, Enable, Start discovery | 2 816 |
| 8b. sign in, click around so the API is observed | 2 936 |
| 8c-0. **reload the dashboard** so discovered endpoints are counted | 2 696 |
| 8c. generate drafts, open the tool, approve | 6 073 |
| 9. first `callTool` from a UTCP client | 704 |
| **total, scripted** | **18 636** |

Machine time from clone to first successful call: ~100 s. `callTool` returned
`{"task":{"id":101,...,"owner":"alice"},"created":true}`.

Add the human-only actions that a script cannot do for you: navigating
`chrome://extensions`, toggling Developer mode, picking the folder, and typing the
runtime URL plus an 8-character code into a popup. Realistically 60–90 s of
attention, plus knowing *what* to type.

## What is architectural and what is an accident

| Step | Verdict |
| --- | --- |
| 1–3. clone / install / build | **Accident.** Distribution. A published package and a store zip remove all three. |
| 4. start the fixture site | **Accident**, and only for a first run. It is a demo prop, not part of the product. |
| 5. start the runtime | **Architectural** — something must run locally. It should be one command, not "find the script". |
| 6. `chrome://extensions` → Load unpacked | **Accident.** There is no distribution: no store listing, no installer. |
| 7. `npm run pair` + paste URL and code | **Accident of the *typing*, not of the mechanism.** The key exchange must stay; the copy/paste must go. |
| 8. dashboard: URL + CSRF path + Enable + Start discovery + Generate + Approve | Mixed. Sign-in and **approval are inherent**. Typing the site URL is inferable from the active tab. Enable/discovery are one intent that the CLI can issue when it knows the origin. |

## Bugs and frictions found while reproducing it

1. **"Generate drafts" stays disabled after traffic until a full page reload.**
   The Websites view computes `endpoints: N` when the list loads, so the button's
   `disabled={domain.endpoints === 0}` never updates. Reloading also resets the SPA
   to *Overview*, so the user must navigate back to Websites. Two hidden steps.
2. **`npm run runtime` reuses `~/.utcp-browser-session` across runs.** A second
   "first run" silently inherits previous domains, tools and approvals; reproducing
   a clean baseline required `UBS_DATA_DIR=$(mktemp -d)`, which the README does not
   mention. It also produced a confusing state where the capture button read
   *Stop discovery* before the user ever pressed *Start*.
3. **The provider example cannot work outside a clone.** `@utcp-browser-session/provider`
   is a workspace package and is not published, so step 8 only runs from the repo
   root. The README does not say so.
4. **`npm install` prints an npm 11 `install-scripts` warning** about esbuild's
   postinstall. Harmless here (the build worked), but alarming on a first run.
5. **Approval is a two-click path with an unlabelled row.** The table row opens a
   drawer; nothing indicates the row is clickable.

## What this means for the target

The eight steps collapse to three user actions:

1. install the extension (store, or `up` launching Chrome with it already loaded),
2. start the runtime (one command),
3. sign in to the site and approve the tool.

Steps 1–3, 6 and 7b are the ones this change set removes: a published package with
a `bin`, an `up` command that builds/launches/loads, and an auto-pair handshake
that removes the typing but keeps the ECDSA exchange. Step 4 becomes `--demo`.
Step 8's "type the site URL" becomes an inference from the active tab.

---

## After: the same journey in three actions

Measured on the same machine, from an installed package (not a checkout).

| | Before | After |
| --- | --- | --- |
| User actions | 8 | 3 |
| Manual steps inside a browser UI | `chrome://extensions` → Developer mode → Load unpacked; paste URL + code; type site URL + CSRF path | sign in, approve |
| Wall clock to a running runtime | clone 2.0 s + install 79.8 s + build 18.7 s ≈ 100 s | `npm i -g ./utcp-browser-session-0.3.0.tgz` ≈ 2 s |
| Wall clock from command to healthy runtime | ≈ 1 s (`npm run runtime`) after ~100 s of setup | **423 ms** |
| From launch to a successful `callTool` | steps 4–8 ≈ 18.6 s of machine time, plus the human work | **5.1 s** (`tests/e2e/first-run.spec.ts`, browser launch included) |

### What `up` replaced

| Old step | Now |
| --- | --- |
| `npm install`, `npm run build` | shipped built inside the package |
| `npm run site` | `--demo` |
| `npm run runtime` | `up` |
| `chrome://extensions` → Load unpacked | `--load-extension` + `--disable-extensions-except`, isolated profile |
| `npm run pair` + paste | auto-pair record, bound to the launched extension id |
| dashboard → type URL + CSRF path → Enable | `--demo` enables the fixture; real sites are still yours to enable |
| Start discovery | starts on connection |
| Generate drafts | automatic as endpoints land |
| Approve | **unchanged — the human step** |

Verify it yourself:

```bash
npm pack && npm install -g ./utcp-browser-session-0.3.0.tgz
time utcp-browser-session up --demo        # browser opens, already paired
# sign in at http://127.0.0.1:8788 (alice / correct-horse), click around
# dashboard → Tools → Approve, then call the tool
```

The machine-checked version of the same claim:

```bash
xvfb-run -a npx playwright test -c tests/e2e/playwright.config.ts first-run.spec.ts
# ✓ up --demo reaches a tool call with no manual pairing (5.1s)
```

### What did not improve

- `npm install` of the *repository* is still ~80 s for contributors. Only users of
  the published package skip it.
- A store-published extension cannot use the path-derived id, so it falls back to
  the manual pairing code. The store build is packaged (`npm run
  package:extension`) but not published.
- Signing in and approving remain human, by design.
