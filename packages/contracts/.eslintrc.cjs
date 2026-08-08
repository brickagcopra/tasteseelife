/**
 * Taste & See — @taste-and-see/contracts ESLint config.
 *
 * Extends the shared base. TS-aware ESLint lands in TS-020; until then `lint`
 * is a no-op for this TS-only package, type errors are caught by `tsc
 * --noEmit` via the `type-check` script.
 */
module.exports = {
  root: false,
  extends: ['@taste-and-see/eslint-config/base.cjs'],
  env: { node: true },
  ignorePatterns: ['generated/**'],
};
