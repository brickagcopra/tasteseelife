import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * web-marketing unit-test configuration (TS-303c2b-followup-1b).
 *
 * The twin of `apps/web-admin/vitest.config.ts`, and narrow for the same
 * reasons. `environment: 'node'`, no jsdom, no React testing library, and
 * `.tsx` is deliberately NOT in the include glob: this app is almost
 * entirely static marketing sections and server components whose bodies
 * are `await fetch` + JSX, and asserting on that markup is Playwright's
 * job (CLAUDE.md §9.1). Adding jsdom would invite component tests that
 * duplicate E2E and make the lane slow enough that people stop running
 * it.
 *
 * What it exists for is `lib/`, which holds two things that are load-
 * bearing rather than cosmetic:
 *
 *   - `blog.ts`, whose whole contract is that **no failure throws**. The
 *     marketing site prerenders in CI where no gateway runs, and must
 *     keep serving its static sections through a gateway outage — so a
 *     regression here does not surface as a broken blog page, it surfaces
 *     as a failed production build.
 *   - `comments.ts`, the Disqus gate, whose doc-block until now carried a
 *     note saying this app had no test lane and the function was
 *     therefore kept total by hand. That note is what this task removes.
 *
 * The `@/` alias mirrors `tsconfig.json`'s `paths`.
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
