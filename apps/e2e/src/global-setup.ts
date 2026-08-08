import { setUpDatabase } from './database';
import { GATEWAY_BASE_URL, type FleetService } from './fleet';
import { startFleet } from './fleet-processes';
import { closeHarnessDatabase } from './harness-db';
import { closeHouseholdDatabase } from './household-flows';
import { loadRepoEnvExample } from './repo-env';

/**
 * Playwright global setup (TS-505): provision the database, then start the
 * fleet. Returns its own teardown, so the two halves of the lifecycle cannot
 * drift apart in separate files.
 *
 * Order is the whole point of this file. Migrations must complete before any
 * service opens a pool, and every service must be ready before the first spec
 * runs. Playwright's `webServer` cannot express that (plugin setup precedes
 * `globalSetup`), which is why the harness owns the processes.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const baseEnv = loadRepoEnvExample();

  const started = Date.now();
  const database = await setUpDatabase(baseEnv);
  log(
    `database ${database.reset ? 'reset and migrated' : 'migrated'} ` +
      `(${database.migrated.join(', ')}) in ${elapsed(started)}`,
  );
  if (database.seeded.length > 0) {
    log(`seeded ${database.seeded.join(', ')}`);
  }

  const fleetStarted = Date.now();
  const fleet = await startFleet(
    (service) => envForService(service, baseEnv, database.databaseUrl),
    {
      readinessTimeoutMs: Number(process.env['E2E_READINESS_TIMEOUT_MS'] ?? '60000'),
    },
  );
  log(`fleet ready at ${GATEWAY_BASE_URL} in ${elapsed(fleetStarted)}`);

  return async () => {
    await fleet.stop();
    await closeHarnessDatabase();
    await closeHouseholdDatabase();
    log('fleet stopped');
  };
}

/**
 * Compose one service's environment: the documented `.env.example` first,
 * then the harness's own overrides, then the service's entry in `FLEET`.
 *
 * `process.env` is deliberately NOT merged in. The fleet's configuration has
 * to be reproducible from files in the repository — if a developer's shell
 * happened to export `JWT_ACCESS_SECRET` or `DATABASE_URL`, a suite that
 * inherited it would pass locally and fail in CI for reasons invisible in the
 * diff. The few values that legitimately vary per machine (`PATH`, and on
 * Windows the loader variables Node needs to start at all) are passed through
 * explicitly below.
 */
function envForService(
  service: FleetService,
  baseEnv: Record<string, string>,
  databaseUrl: string,
): NodeJS.ProcessEnv {
  const passthrough: NodeJS.ProcessEnv = {};
  for (const key of [
    'PATH',
    'Path',
    'SystemRoot',
    'windir',
    'TEMP',
    'TMP',
    'HOME',
    'USERPROFILE',
  ]) {
    const value = process.env[key];
    if (value !== undefined) {
      passthrough[key] = value;
    }
  }

  return {
    ...passthrough,
    ...baseEnv,

    // ── Harness overrides applied to every fleet member ──────────────────
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl,
    // Explicit rather than inherited from each schema's default: the fleet's
    // wiring should be readable in `fleet.ts`, and a drifting default should
    // fail a port assertion rather than quietly relocate a service.
    PORT: String(service.port),
    LOG_LEVEL: process.env['E2E_LOG_LEVEL'] ?? 'warn',
    // No collector is running, and an exporter retrying against a dead
    // endpoint adds seconds to every shutdown plus a wall of noise to every
    // log file. Instrumentation itself is covered by each service's own suite.
    OTEL_TRACES_ENABLED: 'false',
    OTEL_METRICS_ENABLED: 'false',
    SENTRY_DSN: '',

    ...service.env,
  };
}

function log(message: string): void {
  // eslint-disable-next-line no-console -- harness progress belongs on the console; this is not application code.
  console.log(`[e2e] ${message}`);
}

function elapsed(since: number): string {
  return `${((Date.now() - since) / 1000).toFixed(1)}s`;
}
