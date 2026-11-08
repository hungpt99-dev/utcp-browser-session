/**
 * The two invariants that make this product defensible, asserted against the
 * shipped sources rather than trusted to review:
 *
 *   1. the extension never asks for cookie access,
 *   2. nothing in the extension (or the runtime) reads `document.cookie`.
 *
 * They are cheap to break by accident (a permission added to fix a bug, a
 * "helpful" read for debugging), so they are pinned here.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', 'dist', '.git', 'test-results'].includes(entry.name)) continue;
      walk(full, out);
    } else if (/\.(ts|tsx|mjs|js|json)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

describe('extension invariants', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'extension', 'public', 'manifest.json'), 'utf8')) as Record<string, unknown>;

  it('is a Manifest V3 extension', () => {
    assert.equal(manifest.manifest_version, 3);
  });

  it('asks for no cookie permission anywhere in the manifest', () => {
    const declared = [
      ...((manifest.permissions as string[] | undefined) ?? []),
      ...((manifest.optional_permissions as string[] | undefined) ?? []),
      ...((manifest.host_permissions as string[] | undefined) ?? []),
      ...((manifest.optional_host_permissions as string[] | undefined) ?? []),
    ];
    assert.equal(declared.includes('cookies'), false, `permissions were: ${declared.join(', ')}`);
    assert.equal(JSON.stringify(manifest).includes('"cookies"'), false);
  });

  it('declares only the permissions the design needs', () => {
    const permissions = (manifest.permissions as string[] | undefined) ?? [];
    assert.deepEqual(
      [...permissions].sort(),
      ['activeTab', 'alarms', 'scripting', 'storage', 'webRequest'].sort(),
      'a new permission needs a security review, not a quiet addition',
    );
  });

  it('never reads document.cookie or the chrome.cookies API', () => {
    const offenders: string[] = [];
    for (const file of walk(path.join(root, 'extension', 'src'))) {
      const source = fs.readFileSync(file, 'utf8');
      if (/document\s*\.\s*cookie/.test(source)) offenders.push(`${path.relative(root, file)}: document.cookie`);
      if (/chrome\s*\.\s*cookies/.test(source)) offenders.push(`${path.relative(root, file)}: chrome.cookies`);
    }
    assert.deepEqual(offenders, []);
  });

  it('executes with credentials but never forwards a cookie header', () => {
    const background = fs.readFileSync(path.join(root, 'extension', 'src', 'background.ts'), 'utf8');
    assert.ok(background.includes("credentials: 'include'"), 'the browser must attach the session itself');
    const runtimeFiles = walk(path.join(root, 'packages'));
    for (const file of runtimeFiles) {
      const source = fs.readFileSync(file, 'utf8');
      assert.equal(/['"]cookie['"]\s*:/.test(source), false, `${path.relative(root, file)} builds a cookie header`);
    }
  });

  it('keeps redirects manual', () => {
    const background = fs.readFileSync(path.join(root, 'extension', 'src', 'background.ts'), 'utf8');
    assert.ok(background.includes("redirect: 'manual'"), 'redirects are reported, never followed');
  });
});
