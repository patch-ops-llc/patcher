import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'coverage'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['eslint.config.js'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { arguments: false } }],
      'no-console': 'error',
    },
  },
  {
    // The browser extension: plain scripts that Chrome loads as they are, with no build step.
    files: ['extension/**/*.js'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      sourceType: 'script',
      parserOptions: { projectService: false, project: null },
      globals: Object.fromEntries(
        [
          'AbortSignal', 'CustomEvent', 'Event', 'EventTarget', 'Node', 'Notification', 'Proxy', 'Reflect', 'URL', 'chrome', 'clearTimeout', 'document', 'fetch',
          'globalThis', 'importScripts', 'location', 'navigator', 'setInterval', 'setTimeout', 'window',
        ].map((name) => [name, 'readonly']),
      ),
    },
    rules: { ...tseslint.configs.disableTypeChecked.rules, '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }] },
  },
  {
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
    },
  },
  {
    // These drive the extension's untyped scripts, in a stand-in browser and in Chrome: what comes back has no type.
    files: ['test/extension.test.ts', 'test/extension-e2e.test.ts', 'test/fixtures/extension.ts', 'test/fixtures/browser.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-this-alias': 'off',
    },
  },
);
