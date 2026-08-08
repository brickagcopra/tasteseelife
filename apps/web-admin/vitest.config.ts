import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * web-admin unit-test configuration (TS-303c2b-followup-1).
 *
 * **Why this app had no test lane for twenty-odd surfaces, and why it
 * needs one now.** Most of web-admin is server components whose bodies
 * are `await fetch` + JSX — rendering those in a unit test would mean
 * mocking the gateway and asserting on markup, which is an E2E concern
 * (CLAUDE.md §9.1 puts frontend critical paths behind Playwright). But
 * the app has quietly accumulated logic that is load-bearing rather
 * than cosmetic and is testable as plain functions: the RFC 7807 detail
 * sanitiser that puts DOWNSTREAM TEXT into a redirect URL and then onto
 * a page, and the permission gate that decides whether an operator sees
 * a surface at all. Those two are worth a test each far more than any
 * amount of rendered markup is.
 *
 * So the lane is deliberately narrow: `environment: 'node'`, no jsdom,
 * no React testing library, and the include glob covers `lib/` and any
 * co-located `*.test.ts` beside a helper. Adding jsdom would invite
 * component tests that duplicate what Playwright should own and would
 * make this lane slow enough that people stop running it.
 *
 * `.tsx` is deliberately NOT in the include glob. A page that wants
 * coverage should export its pure helper into `lib/` (or a sibling
 * `.ts`) and have that tested — which also stops a helper from being
 * quietly reachable only through a 300-line server component.
 *
 * The `@/` alias mirrors `tsconfig.json`'s `paths`, so a test can
 * import the same specifier the app does.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    globals: false,
    include: ['lib/**/*.test.ts', 'app/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['lib/**/*.ts'],
      exclude: ['lib/**/*.test.ts'],
      reporter: ['text', 'lcov'],
    },
  },
});
