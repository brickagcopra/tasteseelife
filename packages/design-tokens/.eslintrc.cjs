/**
 * Taste & See — @taste-and-see/design-tokens ESLint config.
 *
 * Extends the shared base. TS-aware ESLint lands in TS-020; until then
 * `lint` is a no-op for this TS-only package, type errors are caught by
 * `tsc --noEmit` via `type-check`. The `styles/` directory is hand-authored
 * CSS and is excluded from lint.
 */
module.exports = {
  root: false,
  extends: ['@taste-and-see/eslint-config/base.cjs'],
  env: { node: true },
  ignorePatterns: ['styles/**'],
};
