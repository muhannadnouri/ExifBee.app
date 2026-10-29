import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tauriConf from './src-tauri/tauri.conf.json' with { type: 'json' };

// Tauri expects a fixed dev port and must not watch the Rust crate.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ['**/src-tauri/**'] } },
  // Renderer E2E serves the build with the app's production CSP, so tests run under the same
  // policy the packaged app enforces (S1-T06).
  preview: { headers: { 'Content-Security-Policy': tauriConf.app.security.csp } },
  // Vitest replaces CSS with empty modules; the contrast test reads the real theme tokens.
  test: { css: { include: [/src\/styles\/tokens\.css/] } },
});
