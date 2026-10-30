import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'src-tauri/target', 'src-tauri/gen', 'src/lib/bindings'] },
  {
    files: ['**/*.{ts,tsx,js}'],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.strict,
      reactHooks.configs.flat.recommended,
    ],
    languageOptions: { globals: globals.browser },
  },
  { files: ['scripts/**'], languageOptions: { globals: globals.node } },
  // All Rust calls go through the typed layer in src/lib/ipc.ts (S1-T05, SEC-008).
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/lib/ipc.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: '@tauri-apps/api/core', message: 'Call Rust only through src/lib/ipc.ts.' },
            {
              name: '@tauri-apps/api/event',
              message: 'Listen to Rust only through src/lib/ipc.ts.',
            },
          ],
        },
      ],
    },
  },
);
