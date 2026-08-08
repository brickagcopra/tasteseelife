/**
 * Taste & See — shared Prettier configuration.
 *
 * Single source of truth for code formatting across the monorepo. Apps and
 * packages consume this via the `prettier` field in their package.json:
 *
 *     "prettier": "@taste-and-see/prettier-config"
 *
 * Or via a `.prettierrc` whose contents are the JSON string
 * `"@taste-and-see/prettier-config"` (Prettier resolves the module).
 *
 * Format conventions are intentionally close to community defaults to
 * minimise tool-induced churn; deviations are documented inline.
 */

/** @type {import('prettier').Config} */
module.exports = {
  semi: true,
  singleQuote: true,
  trailingComma: 'all',
  printWidth: 100,
  tabWidth: 2,
  useTabs: false,
  arrowParens: 'always',
  bracketSpacing: true,
  endOfLine: 'lf', // matches .gitattributes — consistent diffs across Win/Linux
  overrides: [
    {
      files: '*.md',
      options: {
        proseWrap: 'preserve',
      },
    },
    {
      files: ['*.yml', '*.yaml'],
      options: {
        singleQuote: false,
      },
    },
  ],
};
