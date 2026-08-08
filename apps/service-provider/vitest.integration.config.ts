import { decoratorMetadata } from '@taste-and-see/testing/vitest-plugin';
import { defineConfig } from 'vitest/config';

/**
 * service-provider integration-test configuration (TS-050-followup-2).
 *
 * Mirrors the canonical shape established by service-identity
 * (`apps/service-identity/vitest.integration.config.ts`) and reaffirmed
 * by service-subscription. Distinct from the unit-test config
 * (`vitest.config.ts`) so the fast unit suite stays pure-Node +
 * millisecond-fast and the slow infra-touching suite is opt-in via the
 * dedicated `pnpm test:integration` script.
 *
 * Integration tests live under `test/integration/**` and own their own
 * container lifecycle via `testcontainers`. Each spec spins up fresh
 * Postgres + Redis containers — slower than a shared global setup, but
 * per-file isolation is the canonical Testcontainers pattern
 * (CLAUDE.md §9.1 / PDD §24.1) and matters more here than the few
 * extra seconds it costs on a runner that already pays the Docker
 * engine warm-up.
 *
 * Shared-harness extraction (TS-009e-followup-1) — with this file
 * service-provider becomes the third service to materialise the
 * canonical integration-test shape (after service-identity and
 * service-subscription). The follow-up's "second-service-integration
 * is the natural extraction trigger" condition is now well-overshot;
 * the canonical Testcontainers bootstrap (Postgres + Redis container
 * start, `prisma migrate deploy` invocation, PrismaClient wiring) is
 * a strong candidate for extraction into `packages/testing/`.
 * Deliberately deferred from this PR to keep the diff tight; the
 * inline shape mirrors the prior two services exactly so a later
 * code-move is mechanical.
 *
 * The shared `tsconfig.json` excludes `test/` from the build but
 * vitest resolves TypeScript via esbuild at run time, so no separate
 * tsconfig is needed for the integration sources.
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
