#!/usr/bin/env node
/**
 * Builds the unpacked MV3 extension into extension/dist.
 *
 *   background.js  ESM service worker (bundled with esbuild)
 *   tap.js         MAIN-world instrumentation (IIFE)
 *   bridge.js      ISOLATED-world relay (IIFE)
 *   popup/         React + MUI popup (Vite)
 *   manifest.json  copied verbatim, plus icons
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import react from '@vitejs/plugin-react';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, 'dist');

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

const shared = { bundle: true, target: 'chrome116', sourcemap: 'linked', logLevel: 'warning' };

await esbuild({
  ...shared,
  entryPoints: [path.join(here, 'src/background.ts')],
  outfile: path.join(dist, 'background.js'),
  format: 'esm',
  platform: 'browser',
});

await esbuild({
  ...shared,
  entryPoints: [path.join(here, 'src/tap.ts')],
  outfile: path.join(dist, 'tap.js'),
  format: 'iife',
  platform: 'browser',
});

await esbuild({
  ...shared,
  entryPoints: [path.join(here, 'src/bridge.ts')],
  outfile: path.join(dist, 'bridge.js'),
  format: 'iife',
  platform: 'browser',
});

await viteBuild({
  configFile: false,
  root: path.join(here, 'src/popup'),
  base: './',
  plugins: [react()],
  define: { 'process.env.NODE_ENV': '"production"' },
  build: {
    outDir: path.join(dist, 'popup'),
    emptyOutDir: true,
    target: 'chrome116',
    rollupOptions: { output: { entryFileNames: 'popup.js', chunkFileNames: 'chunk-[hash].js', assetFileNames: 'asset-[hash][extname]' } },
  },
  logLevel: 'warn',
});

fs.copyFileSync(path.join(here, 'public/manifest.json'), path.join(dist, 'manifest.json'));
fs.cpSync(path.join(here, 'public/icons'), path.join(dist, 'icons'), { recursive: true });

const manifest = JSON.parse(fs.readFileSync(path.join(dist, 'manifest.json'), 'utf8'));
process.stdout.write(`built extension ${manifest.version} -> ${dist}\n`);
