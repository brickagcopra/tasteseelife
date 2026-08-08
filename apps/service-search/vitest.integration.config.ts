import { decoratorMetadata } from '@taste-and-see/testing/vitest-plugin';
import { defineConfig } from 'vitest/config';

/**
 * service-search integration-test configuration (TS-211-followup-5).
 *
 * Mirrors the canonical shape established by service-subscription
 * (`apps/service-subscription/vitest.integration.config.ts`). Distinct
 * from the unit-test config (`vitest.config.ts`) so the fast unit suite
 * stays pure-Node + millisecond-fast and the slow infra-touching suite
 * is opt-in via the dedicated `pnpm test:integration` script.
 *
 * Integration tests live under `test/integration/**` and own their own
 * container lifecycle via the shared `@taste-and-see/testing` harness.
 * service-search has one integration file today (ranking-config); the
 * per-file `startIntegrationTestStack` pattern is the right shape —
 * `setupSharedContainers` (TS-009e-followup-2) only pays off once a
 * service has multiple integration files sharing one Postgres + Redis.
 *
 * The shared `tsconfig.json` excludes `test/` from the build but vitest
 * resolves TypeScript via esbuild at run time, so no separate tsconfig
 * is needed for the integration sources.
 */
/**
 * TS-305d-followup-2b1 — `.ts` in this lane is compiled by TypeScript, not
 * esbuild, so `emitDecoratorMetadata` actually happens.
 *
 * Without it Nest resolves no bare-param constructor dependency: it reads the
 * class as zero-dependency, builds it with holes, and the first call throws
 * `TypeError: Cannot read properties of undefined`. That is not a hypothetical
 * — it made `/readyz` answer 503 against a live Postgres (TS-305d-followup-2b)
 * and it failed 14 of service-search's 17 integration tests inside a
 * controller. Production is unaffected; `tsc` emits the metadata.
 *
 * The plugin's own doc-block carries the full reasoning, including why
 * `ts.transpileModule` and not `@swc/core`.
 */
export default defineConfig({
  plugins: [decoratorMetadata()],
  test: {
    environment: 'node',
    globals: false,
    include: ['test/integration/**/*.test.ts'],
    /**
     * Container start + Prisma `migrate deploy` is ~10–20s on a cold
     * Docker engine; the unit-suite default 5s timeout would flake
     * every run. 60s leaves headroom without hiding genuine hangs.
     */
    testTimeout: 60_000,
    /**
     * `beforeAll` spins the containers — give it the same budget as a
     * test plus margin for image pulls on a cold CI runner.
     */
    hookTimeout: 180_000,
    /**
     * Serial file execution keeps Docker resource pressure bounded on
     * a single GitHub-hosted runner. Re-enable when we add an
     * integration-test runner with more cores.
     */
    fileParallelism: false,
    /**
     * Coverage stays on the unit suite where speed lets us run on
     * every change. Integration tests prove wiring, not branch
     * coverage.
     */
    coverage: { enabled: false },
  },
});
