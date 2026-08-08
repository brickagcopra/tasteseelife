/**
 * Taste & See — @taste-and-see/tracing ESLint config.
 *
 * Extends the shared base. TS-aware ESLint (parser + plugin) lands in TS-020
 * per the TS-002 follow-up. Until then `lint` is a no-op for this TS-only
 * package; type errors are caught by `tsc --noEmit` via `type-check`.
 */
module.exports = {
  root: false,
  extends: ['@taste-and-see/eslint-config/base.cjs'],
  env: { node: true },
};
