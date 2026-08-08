/**
 * Root ESLint config — thin stub that consumes the shared monorepo config.
 *
 * Single source of truth: `packages/eslint-config/base.cjs`. Apps and services
 * extend `@taste-and-see/eslint-config` directly (and add framework-specific
 * variants alongside their first consumer).
 */
/** @type {import('eslint').Linter.Config} */
module.exports = {
  root: true,
  extends: ['@taste-and-see/eslint-config/base.cjs'],
};
