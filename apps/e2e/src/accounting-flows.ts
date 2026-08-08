import {
  AdminJournalDetailResponseSchema,
  AdminJournalsListResponseSchema,
  AdminTrialBalanceResponseSchema,
  type AdminJournalDetail,
  type AdminJournalSummary,
  type AdminTrialBalanceResponse,
} from '@taste-and-see/contracts';

import { gateway, type GatewayResponse } from './gateway-client';

/**
 * Reading the ledger through the surface an accountant uses (TS-505d2).
 *
 * Every read here goes through `GET /api/v1/admin/journals` and
 * `/admin/trial-balance` rather than through the harness's database
 * connection. That is a deliberate cost: the connection is right there, and
 * `SELECT * FROM accounting.journal_lines` would be one line. But the claim
 * this slice makes is that **money is right on the platform**, and a ledger
 * that is correct in Postgres and unreachable through the admin surface has
 * not paid anybody. The gateway also re-validates every response against the
 * contract, so a drifted DTO surfaces here as a 502 instead of passing
 * silently — which a direct read would never see.
 *
 * All of these require an admin session (`registerAdminUser`, TS-505d1).
 */

/**
 * Poll `/admin/journals` until one carries `sourceEventId`.
 *
 * **The wait is the assertion, and it belongs here rather than in a retry
 * count.** Between the booking's committed outbox row and this journal sit two
 * real processes — `worker-outbox-relay` polling Postgres and publishing to a
 * Redis Stream, then service-accounting's consumer reading the stream — and
 * both are genuinely asynchronous. A budget states how long the platform is
 * allowed to take; a retry count states how many times we are willing to be
 * surprised.
 *
 * The default is generous relative to the fleet's cadence (a 250ms relay poll
 * plus the consumer's shipped 5s block) because a slow first run is a worse
 * failure than a slow test: it reads as a broken money path.
 *
 * `sourceEventId` is the outbox row's `event_id`, which is what the relay puts
 * on the envelope and what the recognizer stores — one key, end to end, which
 * is also what makes the whole path idempotent (CLAUDE.md §5.3).
 */
export async function waitForJournalBySourceEvent(
  accessToken: string,
  sourceEventId: string,
  options: { readonly timeoutMs?: number } = {},
): Promise<AdminJournalSummary> {
  const timeoutMs = options.timeoutMs ?? 45_000;
  const deadline = Date.now() + timeoutMs;
  let seen = 0;

  for (;;) {
    const page = await listJournals(accessToken);
    seen = page.length;

    const match = page.find((journal) => journal.sourceEventId === sourceEventId);
    if (match !== undefined) {
      return match;
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `No journal with sourceEventId '${sourceEventId}' appeared within ` +
          `${String(timeoutMs)}ms (${String(seen)} journal${seen === 1 ? '' : 's'} on the ` +
          `first page). Either the relay did not publish the event, or the ` +
          `consumer did not post. Check test-results/fleet/worker-outbox-relay.log ` +
          `and service-accounting.log.`,
      );
    }
    await delay(500);
  }
}

/** `GET /api/v1/admin/journals` — the first page, newest first. */
export async function listJournals(accessToken: string): Promise<AdminJournalSummary[]> {
  const response = await gateway('/api/v1/admin/journals?limit=100', { accessToken });
  expectStatus(response, 200, 'admin/journals');
  return [...AdminJournalsListResponseSchema.parse(response.body).journals];
}

/** `GET /api/v1/admin/journals/:id` — the journal with its lines. */
export async function getJournal(
  accessToken: string,
  journalId: string,
): Promise<AdminJournalDetail> {
  const response = await gateway(`/api/v1/admin/journals/${encodeURIComponent(journalId)}`, {
    accessToken,
  });
  expectStatus(response, 200, `admin/journals/${journalId}`);
  return AdminJournalDetailResponseSchema.parse(response.body).journal;
}

/**
 * `GET /api/v1/admin/trial-balance` with no period scope — the all-time view.
 *
 * All-time on purpose. Scoping to the current period would let a journal
 * posted into an adjacent period (a visit completing either side of a month
 * boundary) vanish from the totals and leave the balance assertion passing on
 * an empty ledger.
 */
export async function getTrialBalance(accessToken: string): Promise<AdminTrialBalanceResponse> {
  const response = await gateway('/api/v1/admin/trial-balance', { accessToken });
  expectStatus(response, 200, 'admin/trial-balance');
  return AdminTrialBalanceResponseSchema.parse(response.body);
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolvePromise) => setTimeout(resolvePromise, ms));
}

function expectStatus(response: GatewayResponse, expected: number, surface: string): void {
  if (response.status !== expected) {
    throw new Error(
      `${surface} returned ${String(response.status)}, expected ${String(expected)}: ${response.text.slice(0, 800)}`,
    );
  }
}
