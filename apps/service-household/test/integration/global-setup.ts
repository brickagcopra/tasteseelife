/**
 * Vitest globalSetup entrypoint for service-household's integration
 * suite (TS-031-followup-5 / TS-009e-followup-2).
 *
 * Boots ONE shared Postgres + Redis pair for the whole suite. Each
 * test file calls `createIsolatedDatabase(...)` in its `beforeAll` to
 * carve out a per-file database (so two files don't share rows) and
 * drops it in `afterAll`. The shared containers are torn down by the
 * teardown closure returned below at suite end.
 *
 * One-line wrapper around `setupSharedContainers` from the shared
 * harness so any future change to the bootstrap landscape (e.g.
 * adding Elasticsearch, switching admin-database name) lives at the
 * single source of truth in `@taste-and-see/testing`.
 *
 * Vitest expects `globalSetup` files to export either a default
 * function or `setup` / `teardown` named exports — we use the default
 * shape because the teardown closure is returned by `setupSharedContainers`.
 *
 * References: PDD §24.1; CLAUDE.md §9.1.
 */
import { setupSharedContainers } from '@taste-and-see/testing';
import type { GlobalSetupContext } from 'vitest/node';

export default async function setup(ctx: GlobalSetupContext): Promise<() => Promise<void>> {
  return setupSharedContainers(ctx);
}
