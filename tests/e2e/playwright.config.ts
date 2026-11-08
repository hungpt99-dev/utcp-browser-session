import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  // A single browser profile is shared by every test in a file; parallel workers
  // would each need their own extension install and pairing.
  workers: 1,
  fullyParallel: false,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['json', { outputFile: '../../test-results/e2e-results.json' }]],
  use: {
    actionTimeout: 15_000,
    trace: 'retain-on-failure',
  },
});
