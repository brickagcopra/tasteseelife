import { decoratorMetadata } from '@taste-and-see/testing/vitest-plugin';
import { defineConfig } from 'vitest/config';

/**
 * service-household integration-test configuration (TS-031-followup-5).
 *
 * Mirrors the canonical shape established by service-identity
 * (`apps/service-identity/vitest.integration.config.ts`). Distinct from
 * the unit-test config (`vitest.config.ts`) so the fast unit suite stays
 * pure-Node + millisecond-fast and the slow infra-touching suite is
 * opt-in via the dedicated `pnpm test:integration` script.
 *
 * Integration tests live under `test/integration/**`. Their lifecycle
 * follows the TS-009e-followup-2 shared-stack model:
 *
 *   - ONE Postgres + Redis pair is booted per suite via the
 *     `globalSetup` file below (which calls into the shared
 *     `@taste-and-see/testing` harness). Connection info reaches each
 *     test file via vitest's `inject(...)` API.
 *   - Each test file's `beforeAll` calls `createIsolatedDatabase(...)`
 *     to carve out a per-file database (so two files don't share rows)
 *     and drops it in `afterAll`.
 *   - Net effect for service-household today: one file (intake) so
 *     the shared-stack savings are nominal — but adopting the shared
 *     pattern keeps the shape consistent with the rest of the
 *     workspace and gets the wiring right before TS-032-followup-4 /
 *     TS-033-followup-7 land their own files alongside.
 *
 * The shared `tsconfig.json` excludes `test/` from the build but
 * vitest resolves TypeScript via esbuild at run time, so no
 * separate tsconfig is needed for the integration sources.
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
     * One shared Postgres + Redis pair booted in globalSetup. See
     * `test/integration/global-setup.ts` for the bootstrap; the
     * harness lives in `@taste-and-see/testing`.
     */
    globalSetup: ['./test/integration/global-setup.ts'],
    /**
     * Per-file `CREATE DATABASE` + `prisma migrate deploy` is ~5–10s
     * on a warm runner; the unit-suite default 5s timeout would flake
     * every run. 60s leaves headroom without hiding genuine hangs.
     */
    testTimeout: 60_000,
    /**
     * `beforeAll` spins the per-file database — give it the same
     * budget as a test plus margin for a cold migrate-deploy.
     */
    hookTimeout: 180_000,
    /**
     * Serial file execution keeps DB resource pressure bounded on a
     * single GitHub-hosted runner. Critical under the shared-stack
     * model: parallel file execution would have multiple files
     * issuing CREATE DATABASE / DROP DATABASE concurrently against
     * the same admin connection, which Postgres serialises anyway.
     * Re-enable when we add an integration-test runner with more cores.
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
