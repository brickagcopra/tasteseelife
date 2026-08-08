import { defineConfig } from '@playwright/test';

import { GATEWAY_BASE_URL } from './src/fleet';

/**
 * Playwright configuration for the Taste & See E2E suite (TS-505,
 * CLAUDE.md §9.1).
 *
 * **API-level, not browser-level — for now.** Every spec drives the
 * api-gateway over HTTP through Playwright's `request` fixture. No browser is
 * launched, so the suite runs without `playwright install` and without the
 * ~400 MB of browser binaries in CI. The money path CLAUDE.md §9.1 names
 * (signup → subscription → booking lifecycle → payout) is a sequence of
 * backend state transitions across eight bounded contexts; asserting it
 * through the gateway asserts the thing that can break. Browser-level specs
 * over the four Next.js portals are a separate, additive slice — they need the
 * portals built and running, and they would re-assert the same backend
 * transitions through a slower and flakier lens.
 *
 * **Fully serial.** `workers: 1` and no parallelism inside a file. The money
 * path is a single narrative over shared platform state — a household, its
 * subscription, a booking, the journal that booking posts. Running two of
 * those concurrently against one database would be testing isolation the
 * platform has never claimed. Speed here comes from the fleet starting once
 * per run, not from concurrency.
 *
 * **No retries, ever — including CI.** A retry that turns a red run green
 * hides exactly the class of defect this suite exists to catch: an event that
 * arrived late, a projection that was not yet consistent, a lock that was not
 * held. Where the platform is genuinely eventually-consistent (outbox relay →
 * consumer), the spec waits explicitly with a stated budget, so the wait is
 * part of the assertion instead of hidden in a retry count.
 */
export default defineConfig({
  testDir: './tests',
  outputDir: './test-results/artifacts',

  globalSetup: require.resolve('./src/global-setup'),

  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env['CI']),

  // Generous per-test budget: several steps in the money path cross a service
  // boundary and wait on the outbox relay. Individual waits carry their own
  // tighter, meaningful budgets; this is only a backstop against a hang.
  timeout: 120_000,
  expect: { timeout: 15_000 },

  reporter: process.env['CI'] === undefined ? [['list']] : [['list'], ['html', { open: 'never' }]],

  use: {
    baseURL: GATEWAY_BASE_URL,
    extraHTTPHeaders: { 'content-type': 'application/json' },
    trace: 'off',
  },
});
