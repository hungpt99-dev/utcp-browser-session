# Packaging

Two artifacts, both reproducible from a clean checkout:

| Artifact | Command | Output |
| --- | --- | --- |
| Runtime CLI | `npm run build:cli` (part of `npm run build`) | `dist/cli.mjs` (~530 KiB, Node built-ins only) |
| Extension | `npm run package:extension` | `dist/packages/utcp-browser-session-extension-v<version>.zip` |
| Store text | `npm run package:extension` | `dist/packages/STORE-LISTING.md`, `PRIVACY.md` |

## The CLI

`packages/runtime/src/cli.ts` is the entry point; `scripts/build-cli.mjs` bundles
it with esbuild into a single ES module. Bundling matters because the workspace
packages import each other by package name (`@utcp-browser-session/shared`), which
only resolves inside the monorepo. The bundle inlines all of them, so the
published package has **no runtime dependencies** — installing it does not pull
`ws`, `zod` or `@utcp/sdk`.

Two details are load-bearing:

- `ws` is CommonJS and calls `require()` internally. An ESM bundle needs a real
  `require`, which the esbuild banner injects via `createRequire(import.meta.url)`.
  Without it the CLI dies on `Dynamic require of "events" is not supported`.
- `bin/utcp-browser-session.mjs` prefers `dist/cli.mjs` and falls back to the
  TypeScript entry, so a checkout (no build) and a published package (bundled)
  run the same code path.

The package root is located by walking up from the CLI until a directory holds
`extension/public/manifest.json` (source layout) or `extension/dist/manifest.json`
(published layout). `up` then serves the dashboard and loads the extension from
that root.

## The extension zip

Written by `scripts/package-extension.mjs` with a small built-in ZIP writer
(deflate via `node:zlib`, CRC-32, fixed timestamps) so packaging needs no `zip`
binary and no new dependency. Source maps are excluded.

The script refuses to package if the manifest mentions `cookies` anywhere, so the
privacy policy cannot silently become false.

### Version and extension id

Version comes from `extension/public/manifest.json`, which `npm run build` copies
into `extension/dist`.

Chrome derives the id of an **unpacked** extension from the absolute path it was
loaded from (SHA-256 → first 16 bytes → a–p). `up` computes the same id with
`extensionIdForPath()` and binds its auto-pair record to it, so only the exact
extension it launched can claim the code. This is verified against a real browser
in `tests/security/auto-pair.test.ts`.

Consequence for store distribution: a published (packed) extension gets an id
assigned by the store, not derived from a path. `up` detects this because the
extension cannot claim the record and falls back to the manual pairing flow; the
popup keeps working unchanged.

## Publishing the runtime

```bash
npm run build
npm pack                 # utcp-browser-session-0.3.0.tgz
npm install -g ./utcp-browser-session-0.3.0.tgz
utcp-browser-session up --demo
```

`files` is limited to the CLI, the built dashboard and extension, and the docs.
`npm pack` output is what was verified in the acceptance report; nothing else is
published.

## What is deliberately not packaged

- No single-file binary (Node SEA / pkg). The bundle plus `node ≥ 22.18` is one
  install step and avoids shipping a 70 MB artifact per platform.
- No postinstall script: nothing runs on install, and no download happens.
