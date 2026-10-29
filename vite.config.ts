import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Tauri expects a fixed dev port and must not watch the Rust crate.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ['**/src-tauri/**'] } },
  // Vitest replaces CSS with empty modules; the contrast test reads the real theme tokens.
  test: { css: { include: [/src\/styles\/tokens\.css/] } },
});
