/**
 * Taste & See — @taste-and-see/e2e ESLint config.
 *
 * Extends the shared base, matching every other TS-only workspace package.
 * Type errors are caught by `tsc --noEmit` via `type-check`.
 */
module.exports = {
  root: false,
  extends: ['@taste-and-see/eslint-config/base.cjs'],
  env: { node: true },
};
