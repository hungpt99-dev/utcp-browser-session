#!/usr/bin/env node
/**
 * Repository lint: a small, dependency-free consistency check.
 *
 * It enforces the rules that actually matter for this project:
 *   1. no `console.*` in library/runtime code (use the structured logger),
 *   2. no TypeScript escape hatches in shipped source,
 *   3. no `eval` / `new Function` in the extension or runtime,
 *   4. no oversized literal credentials,
 *   5. every source file is valid UTF-8 and ends with a newline.
 *
 * `tsc` covers types and the dashboard/extension builds cover the rest.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SKIP_DIRS = new Set(['node_modules', 'dist', 'public', '.git', 'test-results', 'docs', 'screenshots']);

const ALLOW_CONSOLE = new Set([
  'packages/runtime/src/index.ts', // CLI output
  'packages/runtime/src/logger.ts', // the logger itself
  'packages/test-site/src/server.ts', // fixture banner
]);

const problems = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
      continue;
    }
    if (!/\.(ts|tsx|mjs|js|json|md|yml)$/.test(entry.name)) continue;
    const relative = path.relative(ROOT, full);
    const source = fs.readFileSync(full, 'utf8');

    if (!source.endsWith('\n')) problems.push(`${relative}: missing trailing newline`);
    if (source.includes('\uFFFD')) problems.push(`${relative}: contains a replacement character (bad encoding)`);

    const isSource = /\.(ts|tsx)$/.test(entry.name) && relative.startsWith('packages/') || relative.startsWith('extension/src/') || relative.startsWith('dashboard/src/');
    if (!isSource) continue;

    if (!ALLOW_CONSOLE.has(relative) && /(^|[^.\w])console\.(log|info|debug)\(/.test(source)) {
      problems.push(`${relative}: use the structured logger instead of console.*`);
    }
    if (/@ts-ignore|@ts-nocheck/.test(source)) {
      problems.push(`${relative}: TypeScript escape hatch (@ts-ignore/@ts-nocheck)`);
    }
    if (/\beval\s*\(|new Function\s*\(/.test(source)) {
      problems.push(`${relative}: eval / new Function is not allowed`);
    }
    for (const match of source.matchAll(/['"`]([A-Za-z0-9_\-]{40,})['"`]/g)) {
      if (/^[a-f0-9]{40,}$/i.test(match[1]) || /^[A-Za-z0-9_-]{40,}$/.test(match[1])) {
        // Long base64/hex literals are almost always a leaked key or a fixture.
        const line = source.slice(0, match.index).split('\n').length;
        problems.push(`${relative}:${line}: suspicious long literal (possible secret)`);
      }
    }
  }
}

walk(ROOT);

if (problems.length) {
  console.error(`lint: ${problems.length} problem(s)`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log('lint: clean');
