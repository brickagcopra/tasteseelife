/**
 * commitlint configuration — enforces Conventional Commits per CLAUDE.md §2.4.
 *
 * Examples that pass:
 *   feat(booking): add recurring schedule support
 *   fix(identity): reject reused refresh tokens
 *   chore(deps): bump prisma to 5.20.0
 *   docs(prd): clarify Tier 3 commission rate
 *
 * Scopes are not constrained to a fixed list — use the bounded-context
 * (service or package) name when the change is localized, or omit the scope
 * for repo-wide changes. Branch naming convention is enforced separately
 * (CLAUDE.md §11): `feat/{scope}/{short-desc}`, `fix/...`, `chore/...`.
 */

/** @type {import('@commitlint/types').UserConfig} */
module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      [
        'feat',
        'fix',
        'chore',
        'docs',
        'style',
        'refactor',
        'perf',
        'test',
        'build',
        'ci',
        'revert',
      ],
    ],
    'type-case': [2, 'always', 'lower-case'],
    'type-empty': [2, 'never'],
    'scope-case': [2, 'always', 'kebab-case'],
    'subject-case': [2, 'never', ['sentence-case', 'start-case', 'pascal-case', 'upper-case']],
    'subject-empty': [2, 'never'],
    'subject-full-stop': [2, 'never', '.'],
    'header-max-length': [2, 'always', 100],
    'body-max-line-length': [2, 'always', 200],
    'footer-max-line-length': [2, 'always', 200],
  },
};
