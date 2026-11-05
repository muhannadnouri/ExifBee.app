import { defineConfig } from '@playwright/test';
import base from '../../playwright.config';

// Performance baseline (S3-T06): only through `npm run bench:metadata`, never in test runs.
// One worker, so scenarios do not compete for the CPU they are timing.
export default defineConfig({
  ...base,
  testDir: '.',
  testMatch: '*.bench.ts',
  workers: 1,
  // Playwright starts the server in the config's folder; the build lives at the repo root.
  webServer: { ...base.webServer, cwd: '../..' },
  timeout: 600_000,
  projects: [
    {
      name: 'bench',
      use: {
        ...base.projects?.[0]?.use,
        launchOptions: { args: ['--enable-precise-memory-info'] },
      },
    },
  ],
});
