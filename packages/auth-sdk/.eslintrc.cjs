/**
 * Taste & See — @taste-and-see/auth-sdk ESLint config.
 *
 * Extends the shared base. TS-aware ESLint lands in TS-020; until then `lint`
 * is a no-op for this TS-only package, type errors are caught by `tsc
 * --noEmit` via `type-check`.
 */
module.exports = {
  root: false,
  extends: ['@taste-and-see/eslint-config/base.cjs'],
  env: { node: true },
};
