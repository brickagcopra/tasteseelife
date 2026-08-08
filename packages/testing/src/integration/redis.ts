/**
 * Redis-container starter for integration suites.
 *
 * Wraps the verbatim `GenericContainer('redis:7-alpine')` bootstrap
 * that lives in every service's `test/integration/**` file (TS-009e
 * canonical pattern).
 *
 * Pinned tag (`redis:7-alpine`) tracks docker-compose.yml + production.
 * Override via `image` only for narrow version-bump scenarios.
 *
 * Readiness gated on Redis' "Ready to accept connections" log line —
 * the canonical signal that the server socket is bound. No persistence
 * is configured (no AOF, no RDB-on-shutdown): containers are ephemeral
 * and Redis is used here only as a cache / idempotency / lock-store
 * backend whose contents are not load-bearing across runs.
 */
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';

const DEFAULT_REDIS_IMAGE = 'redis:7-alpine';
const REDIS_EXPOSED_PORT = 6379;

export interface StartRedisContainerOptions {
  /** Override the image tag. Defaults to `redis:7-alpine`. */
  readonly image?: string;
}

export interface StartedRedisContainer {
  readonly container: StartedTestContainer;
  /**
   * `redis://host:port` — ready to slot into `process.env.REDIS_URL`
   * or `new Redis({ host, port })`.
   */
  readonly redisUrl: string;
}

/**
 * Boot a Redis-7-alpine container against the local Docker engine.
 *
 * Throws whatever Testcontainers throws on failure. Callers should not
 * catch — the test should fail loudly if the engine is unreachable.
 */
export async function startRedisContainer(
  options: StartRedisContainerOptions = {},
): Promise<StartedRedisContainer> {
  const image = options.image ?? DEFAULT_REDIS_IMAGE;

  const container = await new GenericContainer(image)
    .withExposedPorts(REDIS_EXPOSED_PORT)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .start();

  const redisUrl = `redis://${container.getHost()}:${container.getMappedPort(REDIS_EXPOSED_PORT)}`;
  return { container, redisUrl };
}
