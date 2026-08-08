/**
 * Taste & See — @taste-and-see/sentry ESLint config.
 *
 * Extends the shared base. TS-aware ESLint lands in a later iteration;
 * until then `lint` is a no-op for this TS-only package and type errors
 * are caught by `tsc --noEmit` via `type-check`.
 */
module.exports = {
  root: false,
  extends: ['@taste-and-see/eslint-config/base.cjs'],
  env: { node: true },
};
