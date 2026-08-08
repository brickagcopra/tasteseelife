/**
 * Taste & See — @taste-and-see/logger ESLint config.
 *
 * Extends the shared base. TS-aware ESLint (parser + plugin) is deliberately
 * deferred to TS-020 (the first NestJS service) per the TS-002 follow-up; this
 * package is TS-only, so eslint runs as a no-op until TS support lands. Type
 * errors are caught by `tsc --noEmit` via the `type-check` script.
 */
module.exports = {
  root: false,
  extends: ['@taste-and-see/eslint-config/base.cjs'],
  env: { node: true },
};
