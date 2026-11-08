/**
 * Build a store-ready extension zip plus the text the store asks for.
 *
 *   npm run package:extension
 *
 * Output goes to dist/packages/ and is deliberately reproducible: the same
 * extension/dist produces the same archive name, so a release is traceable to a
 * commit.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const root = process.cwd();
const distDir = path.join(root, 'extension', 'dist');
const outDir = path.join(root, 'dist', 'packages');
const manifestPath = path.join(distDir, 'manifest.json');

if (!fs.existsSync(manifestPath)) {
  console.error('  extension/dist is missing. Run `npm run build` first.');
  process.exit(1);
}


/**
 * Minimal ZIP writer (deflate) so packaging needs no external binary and no new
 * dependency. Chrome's store accepts a normal zip; this produces one.
 */
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, base));
    else if (!entry.name.endsWith('.map')) out.push({ full, name: path.relative(base, full).split(path.sep).join('/') });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function writeZip(sourceDir, zipPath) {
  const files = listFiles(sourceDir);
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const data = fs.readFileSync(file.full);
    const compressed = zlib.deflateRawSync(data, { level: 9 });
    const name = Buffer.from(file.name, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // utf-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12); // fixed date, reproducible archive
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, compressed);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(0, 12);
    entry.writeUInt16LE(0x21, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(compressed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt16LE(0, 30);
    entry.writeUInt16LE(0, 32);
    entry.writeUInt16LE(0, 34);
    entry.writeUInt16LE(0, 36);
    entry.writeUInt32LE(0, 38);
    entry.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([entry, name]));

    offset += local.length + name.length + compressed.length;
  }
  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  fs.writeFileSync(zipPath, Buffer.concat([...chunks, centralBuffer, end]));
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const version = manifest.version;
fs.mkdirSync(outDir, { recursive: true });

// Guard the invariants the store listing claims.
const permissionList = [...(manifest.permissions ?? []), ...(manifest.host_permissions ?? [])];
if (permissionList.includes('cookies')) {
  console.error('  refusing to package: the manifest asks for the cookies permission.');
  process.exit(1);
}
if (JSON.stringify(manifest).includes('"cookies"')) {
  console.error('  refusing to package: "cookies" appears in the manifest.');
  process.exit(1);
}

const zipName = `utcp-browser-session-extension-v${version}.zip`;
const zipPath = path.join(outDir, zipName);
fs.rmSync(zipPath, { force: true });
writeZip(distDir, zipPath);
const size = (fs.statSync(zipPath).size / 1024).toFixed(1);

const PRIVACY = `# Privacy policy — UTCP Browser Session (extension ${version})

## What this extension sends

The extension talks to **one** endpoint: the local runtime you run yourself, on
\`127.0.0.1\` (or \`localhost\`). It sends:

- the method, URL path, query **parameter names**, status code and content type of
  requests made by tabs on sites you explicitly enabled;
- structural JSON shapes (field names and types) when you turn on schema capture;
- for tools you approved: the request the tool describes, executed with your
  session cookie attached by the browser.

## What it never sends

- cookie values, \`Authorization\` headers, passwords or session tokens;
- response bodies of requests you did not approve as a tool;
- page content, keystrokes, form values, screenshots, history or bookmarks;
- anything to a third party. There is no analytics, telemetry, crash reporting or
  remote config. No request goes anywhere except your loopback runtime.

## Cookies

The extension does **not** request the \`cookies\` permission and contains no code
that reads \`document.cookie\`. When it executes an approved tool it calls
\`fetch(..., { credentials: 'include' })\`, which makes Chrome attach the site's
own cookies at the network layer — the same thing the page does. The extension's
JavaScript never sees those values, and they never reach the runtime.

## Storage

\`chrome.storage.local\` holds: the runtime URL, the paired client id, the
extension's own P-256 key pair (used to sign the handshake), and the list of
origins you enabled. No website data and no credentials.

## Permissions and why

| Permission | Why |
| --- | --- |
| \`storage\` | keep the pairing key and the enabled-origin list |
| \`webRequest\` | observe method/path/status for sites you enabled, so tools can be generated |
| \`scripting\` + \`activeTab\` | read JSON *shapes* on pages where you turned on schema capture |
| \`alarms\` | reconnect to the runtime after the service worker is suspended |
| \`http://127.0.0.1/*\`, \`http://localhost/*\` | reach the local runtime |
| \`https://*/*\` (optional) | only if you enable a site; granted per-origin at that moment |

## Removing data

Unpair in the popup, or remove the extension. The runtime's state lives in
\`~/.utcp-browser-session\` on your machine and can be deleted at any time.
`;

const LISTING = `# Store listing — UTCP Browser Session ${version}

## Short description (132 chars)
Turn the sites you are already signed in to into tools an AI agent can call — through your own browser session, with your approval.

## Detailed description
Your agent needs Jira. Or GitHub. Or the internal admin panel. Today that means a
new integration, a new token, and a new place to leak it.

UTCP Browser Session does something simpler: it uses the session you already
have. Sign in to a site as usual, let the extension observe the JSON API the page
calls, and approve the operations you want exposed. The agent then calls them
through the native UTCP protocol — executed inside your browser, with your
cookies, on the exact origin you approved.

- Native UTCP: a real provider for the official SDK, not an MCP shim.
- Nothing runs without your approval. Drafts are invisible to the agent.
- One credential for the agent (execute-only) and one for you (approve).
- Undo at any time: revoke a tool or disable a site; the agent loses access.
- No telemetry. No account. Nothing leaves your machine except the request you
  approved.

## What it does not do
It does not read your cookies, does not bypass bot detection or CAPTCHAs, does
not proxy arbitrary URLs, and does not work on sites that reject extension
origins or need a same-origin \`Origin\` header. See the limitations page.

## Permission justification
Each permission is listed with its purpose in the privacy policy. The extension
requests no cookie access and no permission to read your browsing history.
`;

fs.writeFileSync(path.join(outDir, 'PRIVACY.md'), PRIVACY);
fs.writeFileSync(path.join(outDir, 'STORE-LISTING.md'), LISTING);
fs.writeFileSync(
  path.join(outDir, 'manifest.json'),
  `${JSON.stringify({ name: manifest.name, version, permissions: manifest.permissions, host_permissions: manifest.host_permissions }, null, 2)}\n`,
);

console.log(`  packaged ${zipName} (${size} KiB)`);
console.log(`  wrote dist/packages/PRIVACY.md, STORE-LISTING.md, manifest.json`);
console.log(`  extension id from this path: run \`npm run up -- --no-browser\` and read the banner`);
