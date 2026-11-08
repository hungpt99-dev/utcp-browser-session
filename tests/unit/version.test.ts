import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../../packages/runtime/src/version.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function read(relative: string): { version: string } {
  return JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8')) as { version: string };
}

describe('version', () => {
  it('matches every published manifest', () => {
    for (const file of [
      'package.json',
      'extension/public/manifest.json',
      'packages/runtime/package.json',
      'packages/provider/package.json',
      'dashboard/package.json',
    ]) {
      assert.equal(read(file).version, VERSION, `${file} is out of step with version.ts`);
    }
  });
});
