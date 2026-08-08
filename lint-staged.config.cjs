/**
 * lint-staged configuration — runs lint + format on changed files only.
 *
 * Type-check and unit tests on **affected packages** are run from the
 * pre-commit hook itself (see `.husky/pre-commit`) rather than here, because
 * TypeScript and test runners need whole-project context, not per-file
 * invocation. This honours CLAUDE.md §2.4's "lint, type-check, and unit
 * tests on changed files" intent while remaining correct under TS's
 * project-graph semantics.
 *
 * ESLint runs with `--max-warnings=0` so any new warning fails the commit
 * and surfaces immediately, per the standards in CLAUDE.md §2.
 *
 * ---------------------------------------------------------------------------
 * TS-009-followup-1 — why the ESLint matcher excludes `.ts` / `.tsx`
 *
 * It used to include them, and it could never have worked: no ESLint config in
 * this repo configures a TypeScript parser. `packages/eslint-config/base.cjs`
 * sets `parserOptions.ecmaVersion` but no `parser`, so ESLint falls back to
 * espree, which cannot read type annotations — every `.ts` file fails with
 * `Parsing error: Unexpected token`. This was invisible because the repository
 * had no commits, so the hook had never run.
 *
 * It is invisible in CI for a different and more serious reason: each package's
 * lint script is `eslint .` with no `--ext`, and ESLint 8 lints only `.js` by
 * default when handed a directory. Measured in `apps/service-webhook`:
 * `eslint .` lints exactly ONE file — its own `.eslintrc.cjs` — out of 40
 * TypeScript sources. So `turbo run lint` is green because it examines no
 * TypeScript at all, including the CLAUDE.md §3.9 banned-pattern rules
 * (`no-eval`, `no-empty` for silently swallowed catches) this config exists to
 * enforce.
 *
 * This matcher is therefore narrowed to the file types ESLint can currently
 * parse, which makes the hook honest rather than broken. It deliberately does
 * NOT fix the real gap — wiring `@typescript-eslint/parser` and `--ext` across
 * 34 packages is its own task, filed as TS-009-followup-1. A probe with a
 * proper parser over `apps/service-webhook` found 40 files linted and zero real
 * violations, so the fix looks cheap; that is one package of 34 and is a
 * sighting, not a measurement of the whole workspace.
 */

/**
 * ESLint 8 ignores dot-directories (`.ladle/`, `.husky/`, …) by default. When
 * lint-staged passes such a file EXPLICITLY, ESLint does not skip it silently —
 * it emits `File ignored by default` as a *warning*, which `--max-warnings=0`
 * then turns into a failed commit. `packages/ui/.ladle/config.mjs` does exactly
 * this.
 *
 * Rather than hardcode that path — which would silently rot the moment another
 * dot-directory appears — ask ESLint itself which files it ignores. This is the
 * lint-staged FAQ's own recipe, and it cannot drift from the config because the
 * config is what answers.
 */
const removeIgnoredFiles = async (files) => {
  const { ESLint } = require('eslint');
  const eslint = new ESLint();
  const ignored = await Promise.all(files.map((file) => eslint.isPathIgnored(file)));
  return files.filter((_, i) => !ignored[i]);
};

/** @type {import('lint-staged').Configuration} */
module.exports = {
  '*.{js,jsx,cjs,mjs}': async (files) => {
    const linted = await removeIgnoredFiles(files);
    if (linted.length === 0) return [];
    return [`eslint --max-warnings=0 --fix ${linted.map((f) => JSON.stringify(f)).join(' ')}`];
  },
  '*.{ts,tsx,js,jsx,cjs,mjs,json,md,yml,yaml,html,css}': ['prettier --write --ignore-unknown'],
};
