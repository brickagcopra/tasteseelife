/**
 * Taste & See — @taste-and-see/nest-outbox-consumer ESLint config.
 *
 * Extends the shared base. Same shape as nest-outbox sibling: TS-aware
 * ESLint lands later; until then `lint` is a no-op for this TS-only
 * package and type errors are caught by `tsc --noEmit` via `type-check`.
 */
module.exports = {
  root: false,
  extends: ['@taste-and-see/eslint-config/base.cjs'],
  env: { node: true },
};
