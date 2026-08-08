/**
 * Taste & See — web-marketing ESLint config.
 *
 * Extends `next/core-web-vitals` for Next + React + a11y rules, layered on
 * top of the workspace's shared base. This is the first frontend consumer
 * to add the Next-specific lint pack per the TS-002 follow-up.
 */
module.exports = {
  root: false,
  extends: ['@taste-and-see/eslint-config/base.cjs', 'next/core-web-vitals'],
  ignorePatterns: ['.next/', 'node_modules/'],
};
