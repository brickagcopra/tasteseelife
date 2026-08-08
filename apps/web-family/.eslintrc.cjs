/**
 * Taste & See — web-family ESLint config (TS-121).
 *
 * Mirrors web-marketing's setup: extends `next/core-web-vitals` for the
 * Next + React + a11y rule pack on top of the workspace's shared base.
 */
module.exports = {
  root: false,
  extends: ['@taste-and-see/eslint-config/base.cjs', 'next/core-web-vitals'],
  ignorePatterns: ['.next/', 'node_modules/'],
};
