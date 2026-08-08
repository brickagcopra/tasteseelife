/** @type {import('eslint').Linter.Config} */
module.exports = {
  root: true,
  extends: ['@taste-and-see/eslint-config/base.cjs'],
  parserOptions: {
    sourceType: 'module',
  },
  ignorePatterns: ['dist/', 'node_modules/', 'prisma/migrations/'],
};
