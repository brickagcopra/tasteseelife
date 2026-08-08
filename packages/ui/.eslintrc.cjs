/**
 * Taste & See — @taste-and-see/ui ESLint config.
 *
 * Extends the shared base, adds React + a11y rules. This is the first
 * React-targeted package in the monorepo; once we have a second consumer,
 * the React preset should be promoted into `@taste-and-see/eslint-config/react.cjs`.
 *
 * The Ladle-only files under `.ladle/` and `src/**\/*.stories.tsx` get a
 * console.* allowance so the prototype can `console.warn` from the
 * senior-mode toggle without tripping the base config.
 */
module.exports = {
  root: false,
  extends: ['@taste-and-see/eslint-config/base.cjs'],
  env: { browser: true, node: true },
  ignorePatterns: ['dist/', 'build/', 'src/styles/**'],
  overrides: [
    {
      files: ['**/*.{ts,tsx}'],
      parser: '@typescript-eslint/parser',
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
      extends: [
        'plugin:react/recommended',
        'plugin:react/jsx-runtime',
        'plugin:react-hooks/recommended',
        'plugin:jsx-a11y/recommended',
      ],
      settings: { react: { version: '19' } },
      rules: {
        // We use TypeScript for prop typing — prop-types is redundant noise
        // and trips on rest-spread component patterns (Radix forwards).
        'react/prop-types': 'off',
      },
    },
    {
      files: ['.ladle/**/*.{ts,tsx}', 'src/**/*.stories.tsx'],
      rules: {
        'no-console': 'off',
      },
    },
  ],
};
