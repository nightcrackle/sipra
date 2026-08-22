import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Lint configuration.
 *
 * Deliberately lean. `tsc --noEmit` already catches type errors, so this
 * focuses on the things types cannot see: unused code, unsafe patterns,
 * and accidental `console` calls left in the renderer.
 */
export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'dist-electron/**',
      'release/**',
      'node_modules/**',
      'python/**',
      'coverage/**',
      'assets/**',
      'build/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node, ...globals.es2022 },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'warn',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
      'no-var': 'error',
      'object-shorthand': 'warn',
    },
  },

  {
    // Build scripts are plain Node and talk to the terminal.
    files: ['scripts/**/*.mjs', '*.config.ts', '*.config.js'],
    languageOptions: { globals: globals.node },
    rules: { 'no-console': 'off', '@typescript-eslint/no-explicit-any': 'off' },
  },

  {
    // The main process legitimately logs to stderr for diagnostics.
    files: ['electron/**/*.ts'],
    rules: { 'no-console': ['warn', { allow: ['warn', 'error'] }] },
  },

  {
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
