/**
 * Postgres-container starter for integration suites.
 *
 * Wraps the verbatim `GenericContainer('postgres:16-alpine')` bootstrap
 * that lives in every service's `test/integration/**` file (TS-009e
 * canonical pattern). Returns the started container plus the
 * connection URL the caller wires into env / Prisma / harness clients.
 *
 * Pinned tag (`postgres:16-alpine`) tracks docker-compose.yml + the
 * production deployment so dev / test / CI all exercise the same major.
 * Override via `image` only for narrow scenarios (e.g. testing a
 * version bump on a feature branch before flipping the default).
 *
 * Defaults:
 *   - user/password are test-only placeholders (`tastesee` /
 *     `tastesee_test_only`); the container is ephemeral + tmpfs-backed,
 *     so the credential is local to the test run and never reachable
 *     off-host.
 *   - data directory mounted on tmpfs (`/var/lib/postgresql/data`) so
 *     writes never hit the runner's disk. Shaves seconds off
 *     `prisma migrate deploy` against a cold runner.
 *   - readiness gated on the "ready to accept connections" log line
 *     appearing twice — Postgres logs the message once during initdb
 *     and once after the post-init restart, so waiting for the second
 *     occurrence avoids the race where `pg_isready` returns ok but the
 *     real listener isn't bound yet.
 */
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';

/** Sentinel: change this if we ever migrate off `postgres:16-alpine`. */
const DEFAULT_POSTGRES_IMAGE = 'postgres:16-alpine';
const DEFAULT_POSTGRES_USER = 'tastesee';
const DEFAULT_POSTGRES_PASSWORD = 'tastesee_test_only';
const POSTGRES_EXPOSED_PORT = 5432;

export interface StartPostgresContainerOptions {
  /**
   * Postgres database name to create on first boot. Required so each
   * service's suite picks a unique name (`identity_test`,
   * `subscription_test`, `provider_test`, …) and a future
   * shared-container upgrade can't accidentally let two suites read
   * each other's rows.
   */
  readonly database: string;
  /**
   * Override the image tag. Defaults to `postgres:16-alpine`.
   */
  readonly image?: string;
  /**
   * Override the Postgres user. Defaults to `tastesee`. Tests should
   * almost never need to change this — the role is created at first
   * boot with full superuser rights on the ephemeral database.
   */
  readonly user?: string;
  /**
   * Override the Postgres password. Test-only placeholder by default.
   * Reachable only from inside the container's loopback during the
   * test run.
   */
  readonly password?: string;
}

export interface StartedPostgresContainer {
  /** The underlying Testcontainers handle (for advanced inspection). */
  readonly container: StartedTestContainer;
  /**
   * `postgresql://user:password@host:port/database` — ready to slot
   * into `process.env.DATABASE_URL` or a `new PrismaClient({
   * datasourceUrl })`.
   */
  readonly databaseUrl: string;
}

/**
 * Boot a Postgres-16-alpine container against the local Docker engine.
 *
 * Throws whatever Testcontainers throws on failure (typically a
 * "Could not find a working container runtime strategy" error when
 * Docker is not running). Callers should not catch — the test should
 * fail loudly if the engine is unreachable.
 */
export async function startPostgresContainer(
  options: StartPostgresContainerOptions,
): Promise<StartedPostgresContainer> {
  if (options.database.length === 0) {
    throw new Error('startPostgresContainer: `database` must be a non-empty string');
  }

  const image = options.image ?? DEFAULT_POSTGRES_IMAGE;
  const user = options.user ?? DEFAULT_POSTGRES_USER;
  const password = options.password ?? DEFAULT_POSTGRES_PASSWORD;

  const container = await new GenericContainer(image)
    .withEnvironment({
      POSTGRES_USER: user,
      POSTGRES_PASSWORD: password,
      POSTGRES_DB: options.database,
    })
    .withExposedPorts(POSTGRES_EXPOSED_PORT)
    .withTmpFs({ '/var/lib/postgresql/data': 'rw' })
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();

  const databaseUrl =
    `postgresql://${user}:${password}` +
    `@${container.getHost()}:${container.getMappedPort(POSTGRES_EXPOSED_PORT)}` +
    `/${options.database}`;

  return { container, databaseUrl };
}
