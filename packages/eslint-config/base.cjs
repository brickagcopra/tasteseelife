/**
 * Taste & See — base ESLint config (language-agnostic).
 *
 * This is the foundation extended by every app and service. It encodes the
 * security-relevant rules from CLAUDE.md §3.9 (banned patterns) and the
 * "no quiet drift" stance from §2.4 (lint runs at `--max-warnings=0` in
 * lint-staged, so warnings fail commits — keep severities deliberate).
 *
 * Framework-specific variants (TypeScript, Next.js, React) will land here
 * alongside their first consumer (TS-020 identity, TS-120 web-marketing,
 * TS-008 ui package, etc.) so plugin dependencies arrive only when needed.
 */

/** @type {import('eslint').Linter.Config} */
module.exports = {
  env: {
    node: true,
    es2022: true,
  },
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  ignorePatterns: [
    'node_modules/',
    'dist/',
    'build/',
    '.next/',
    'out/',
    'coverage/',
    '.turbo/',
    'pnpm-lock.yaml',
    '*.min.js',
    // Per-service generated Prisma clients (TS-500/TS-501). Machine-generated,
    // gitignored, and single-line — linting them buries real findings under
    // thousands of style errors from vendored code nobody edits.
    'prisma/generated/',
  ],
  rules: {
    // Banned-pattern enforcement — CLAUDE.md §3.9, §17
    'no-eval': 'error',
    'no-implied-eval': 'error',
    'no-new-func': 'error',
    'no-empty': ['error', { allowEmptyCatch: false }], // §3.9: no silent error swallowing

    // Hygiene
    'no-console': ['warn', { allow: ['warn', 'error'] }],
    'no-debugger': 'error',
    eqeqeq: ['error', 'always', { null: 'ignore' }],
  },
  overrides: [
    {
      files: ['*.cjs'],
      env: { node: true, commonjs: true },
    },
  ],
};
