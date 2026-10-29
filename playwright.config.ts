import { defineConfig, devices } from '@playwright/test';

const desktop = { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } };

// Renderer E2E (SPEC §6.1): the built frontend in Chromium with the Tauri bridge mocked.
// `behavior` runs anywhere. `snapshots` compares pixels, so it runs only inside the pinned
// Playwright image (`npm run test:e2e:renderer:docker`, CI) where fonts and browser always match.
export default defineConfig({
  testDir: 'tests/renderer',
  testMatch: '*.e2e.ts',
  reporter: 'list',
  // One baseline per snapshot, not per OS: baselines come only from the pinned container.
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFileName}/{arg}{ext}',
  use: { baseURL: 'http://localhost:4173' },
  projects: [
    { name: 'behavior', testIgnore: '*.snapshots.e2e.ts', use: desktop },
    { name: 'snapshots', testMatch: '*.snapshots.e2e.ts', use: desktop },
  ],
  // Production build, so CSS arrives as a <link> exactly as the packaged app loads it.
  webServer: {
    command: 'npm run build:web && npx vite preview --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
