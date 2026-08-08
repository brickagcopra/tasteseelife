/**
 * Public surface for the integration-test harness (TS-009e-followup-1).
 *
 * All symbols a consumer should ever need are re-exported here.
 * Consumers import from `'@taste-and-see/testing'` (the package's
 * single export entry); the per-module file boundaries below are an
 * internal organisation choice that may change without breaking the
 * public API.
 */
export {
  startIntegrationTestStack,
  type IntegrationTestStack,
  type StartIntegrationTestStackOptions,
} from './stack';

export {
  startPostgresContainer,
  type StartPostgresContainerOptions,
  type StartedPostgresContainer,
} from './postgres';

export {
  startRedisContainer,
  type StartRedisContainerOptions,
  type StartedRedisContainer,
} from './redis';

export { applyPrismaMigrations, type ApplyPrismaMigrationsOptions } from './prisma-migrate';

export {
  createIsolatedDatabase,
  type CreateIsolatedDatabaseOptions,
  type IsolatedDatabaseHandle,
} from './isolated-database';

export { setupSharedContainers, type SetupSharedContainersOptions } from './global-setup';

// Re-export the canonical Testcontainers `StartedTestContainer` type so
// consumers can hold a reference to the underlying container handle
// without taking a direct dependency on `testcontainers`. They CAN, but
// the harness is the single entry point and importing the type from
// here keeps the consumer's `testcontainers` symbol unused after
// migration.
export type { StartedTestContainer } from 'testcontainers';
