import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../../packages/runtime/src/store.ts';

function tempStore(): { store: Store; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ubs-audit-'));
  return { store: Store.open(dir), dir };
}

describe('audit hash chain', () => {
  it('verifies a chain it wrote itself', () => {
    const { store, dir } = tempStore();
    store.audit({ kind: 'a', severity: 'info', actor: 'runtime', message: 'first' });
    store.audit({ kind: 'b', severity: 'warn', actor: 'utcp', origin: 'https://example.com', message: 'second' });
    store.audit({ kind: 'c', severity: 'error', actor: 'dashboard', message: 'third' });

    const report = store.verifyAudit();
    assert.equal(report.ok, true);
    assert.equal(report.checked, 3);
    assert.equal(report.brokenAt, null);
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('detects a modified entry', () => {
    const { store, dir } = tempStore();
    store.audit({ kind: 'a', severity: 'info', actor: 'runtime', message: 'first' });
    store.audit({ kind: 'b', severity: 'info', actor: 'runtime', message: 'second' });
    store.close();

    const file = path.join(dir, 'audit.ndjson');
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    const entry = JSON.parse(lines[0]) as { message: string };
    entry.message = 'tampered';
    lines[0] = JSON.stringify(entry);
    fs.writeFileSync(file, `${lines.join('\n')}\n`);

    const reopened = Store.open(dir);
    const report = reopened.verifyAudit();
    assert.equal(report.ok, false, 'a rewritten entry must break the chain');
    assert.ok(report.brokenAt);
    reopened.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps the chain head across a restart', () => {
    const { store, dir } = tempStore();
    store.audit({ kind: 'a', severity: 'info', actor: 'runtime', message: 'before restart' });
    store.close();

    const reopened = Store.open(dir);
    const next = reopened.audit({ kind: 'b', severity: 'info', actor: 'runtime', message: 'after restart' });
    assert.equal(next.prevHash.length, 64);
    assert.equal(reopened.verifyAudit().ok, true);
    reopened.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
