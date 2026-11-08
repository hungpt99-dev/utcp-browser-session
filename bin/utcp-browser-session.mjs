#!/usr/bin/env node
// Prefer the bundled CLI (published package); fall back to the TypeScript entry
// (a checkout, where Node >= 22.18 strips types at import time).
import fs from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';

const bundled = fileURLToPath(new URL('../dist/cli.mjs', import.meta.url));
const source = fileURLToPath(new URL('../packages/runtime/src/cli.ts', import.meta.url));
const entry = fs.existsSync(bundled) ? bundled : source;

const { main } = await import(pathToFileURL(entry).href);
process.exit(await main(process.argv.slice(2)));
