import { decoratorMetadata } from '@taste-and-see/testing/vitest-plugin';
import { defineConfig } from 'vitest/config';

/**
 * worker-identity-janitor integration-test configuration
 * (TS-022-followup-3b).
 *
 * Distinct from the unit-test config (`vitest.config.ts`) so the fast
 * unit suite stays pure-Node + millisecond-fast (it drives the batch
 * loop against a fake executor) and the slow infra-touching suite is
 * opt-in via the dedicated `pnpm test:integration` script.
 *
 * Unlike the service integration suites (TS-009e-followup-2), this
 * worker does NOT use a `globalSetup` shared-container model: it owns a
 * single integration file that needs ONLY Postgres (no Redis, no Prisma
 * migrate-deploy), so a per-file `startPostgresContainer` in `beforeAll`
 * is the simpler shape. If a second integration file lands here, lift to
 * the shared-stack / `inject(...)` pattern then.
 *
 * The shared `tsconfig.json` includes only `src/**`, so `test/` is not
 * type-checked by `tsc`; vitest resolves the TypeScript via esbuild at
 * run time — the same arrangement every service integration suite uses.
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
     * A cold Postgres-container boot + DDL is a few seconds on a warm
     * runner; the unit-suite default 5s timeout would flake every run.
     * 60s leaves headroom without hiding genuine hangs.
     */
    testTimeout: 60_000,
    /**
     * `beforeAll` spins the container + applies the DDL — give it the
     * same budget as a test plus margin for a cold image pull.
     */
    hookTimeout: 180_000,
    /**
     * Serial file execution keeps DB resource pressure bounded on a
     * single GitHub-hosted runner (a no-op today with one file; kept
     * for parity with the service suites).
     */
    fileParallelism: false,
    /**
     * Coverage stays on the unit suite where speed lets us run on every
     * change. Integration tests prove wiring against the real driver,
     * not branch coverage.
     */
    coverage: { enabled: false },
  },
});
