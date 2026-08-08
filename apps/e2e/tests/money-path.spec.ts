import { BOOKING_COMPLETED } from '@taste-and-see/contracts';
import { expect, test } from '@playwright/test';

import { getJournal, getTrialBalance, waitForJournalBySourceEvent } from '../src/accounting-flows';
import { registerAdminUser } from '../src/admin-flows';
import { registerVerifiedUser } from '../src/auth-flows';
import {
  completeBooking,
  createConciergeBooking,
  householdId,
  seniorId,
  setHouseholdTier,
  setProviderTier,
} from '../src/booking-flows';
import { waitForOutboxEvent } from '../src/outbox-reader';
import { providerDocument } from '../src/search-flows';

/**
 * The money path (TS-505d2; CLAUDE.md §6, PDD §11 + Appendix A).
 *
 * **What had never run.** `service-accounting`'s `BookingCompletedHandler` has
 * existed, fully unit-tested, since TS-083-followup-3. `worker-outbox-relay`
 * has existed since TS-142. Neither had ever seen the other: the producer
 * commits a row in `booking.outbox_events`, a separate process publishes it to
 * a Redis Stream, and a third reads the stream and posts a journal — and every
 * suite on the platform stubs at least one of those hops. This spec runs all
 * five processes and asserts the number that comes out the far end.
 *
 * **The assertion is the ledger, not the event.** An event proves a message
 * was sent. A balanced journal with a `Provider Payable` credit proves the
 * platform recognised revenue it can report and a debt it owes a real person —
 * which is the thing §6 is about.
 *
 * **$150 at 20% is PDD Appendix A's worked example, and it is not a
 * coincidence.** `companion_dining`'s platform default is `basePriceMinor:
 * 15_000` at `DEFAULT_COMMISSION_RATE_BPS: 2_000`, and Appendix A's entry
 * reads "Booking completed ($150, 20% commission): Cash $150 / Marketplace
 * Revenue (gross) $150" and "Same booking, provider portion: Marketplace
 * Revenue (contra) $120 / Provider Payable $120". The spec asserts those exact
 * figures, so a change to either the catalog or the recognizer that silently
 * parts them from the design document fails here.
 */

/** `companion_dining` at the Phase-1 platform default. */
const GROSS_MINOR = 15_000;
const MARKETPLACE_MINOR = 3_000;
const PROVIDER_MINOR = 12_000;

/**
 * The four chart-of-accounts codes the booking-completion journal touches,
 * restated rather than imported from `BOOKING_COMMISSION_ACCOUNT_CODES`.
 *
 * A code change is a chart-of-accounts migration, not a refactor — the
 * recognizer's own doc-block says so — and this spec should refuse to keep
 * passing through one. Importing the constant would make the assertion agree
 * with whatever the service currently thinks, which is the opposite of what a
 * ledger test is for.
 */
const ACCOUNT = {
  cash: '1000',
  providerPayable: '2100',
  marketplaceRevenue: '4100',
  marketplaceRevenueContra: '4500',
} as const;

test.describe('money path', () => {
  test('a completed visit posts a balanced journal carrying the provider payable', async () => {
    const admin = await registerAdminUser('money-path');
    const family = await registerVerifiedUser('money-path-family');
    const household = householdId();
    const provider = providerDocument({ tier: 'elite' });

    await setHouseholdTier(household, 'tier_3_concierge');
    await setProviderTier(provider.providerId, 'elite');

    const booking = await createConciergeBooking({
      accessToken: family.accessToken,
      householdId: household,
      seniorId: seniorId(),
      providerId: provider.providerId,
      serviceKind: 'companion_dining',
    });
    await completeBooking(family.accessToken, booking.id);

    // The producer's committed row. Read from `booking.outbox_events` because
    // its `event_id` is the key that travels the whole way: the relay puts it
    // on the envelope, the recognizer stores it as `sourceEventId`, and it is
    // what makes a redelivery idempotent (CLAUDE.md §5.3). Finding the journal
    // by it — rather than by "the newest journal" — means a concurrent spec's
    // booking cannot make this one pass.
    const completed = await waitForOutboxEvent(
      BOOKING_COMPLETED,
      (payload) => payload['bookingId'] === booking.id,
      { schema: 'booking' },
    );
    expect(completed.payload).toMatchObject({
      grossAmountMinor: GROSS_MINOR,
      providerAmountMinor: PROVIDER_MINOR,
      marketplaceAmountMinor: MARKETPLACE_MINOR,
      currency: 'USD',
    });

    // ── relay → Redis Stream → consumer → journal ──────────────────────
    const summary = await waitForJournalBySourceEvent(admin.accessToken, completed.eventId);

    // Double-entry, asserted at the level §6 states it: debits equal credits.
    expect(summary.totalDebitMinor).toBe(summary.totalCreditMinor);
    expect(summary.totalDebitMinor).toBe(GROSS_MINOR + PROVIDER_MINOR);

    const journal = await getJournal(admin.accessToken, summary.id);
    const byAccount = new Map(journal.lines.map((line) => [line.accountCode, line]));

    // PDD Appendix A, both entries, line for line.
    expect(byAccount.get(ACCOUNT.cash)).toMatchObject({
      debitMinor: GROSS_MINOR,
      creditMinor: 0,
    });
    expect(byAccount.get(ACCOUNT.marketplaceRevenue)).toMatchObject({
      debitMinor: 0,
      creditMinor: GROSS_MINOR,
    });
    expect(byAccount.get(ACCOUNT.marketplaceRevenueContra)).toMatchObject({
      debitMinor: PROVIDER_MINOR,
      creditMinor: 0,
    });

    // The liability. A completed visit the platform has not recorded as owed
    // to the provider is the failure this whole slice exists to make visible.
    const payable = byAccount.get(ACCOUNT.providerPayable);
    expect(payable, 'no Provider Payable line on the journal').toBeDefined();
    expect(payable).toMatchObject({ debitMinor: 0, creditMinor: PROVIDER_MINOR });
  });

  test('the trial balance nets to zero', async () => {
    const admin = await registerAdminUser('trial-balance');
    const family = await registerVerifiedUser('trial-balance-family');
    const household = householdId();
    const provider = providerDocument({ tier: 'elite' });

    await setHouseholdTier(household, 'tier_1_essential');
    await setProviderTier(provider.providerId, 'certified');

    const booking = await createConciergeBooking({
      accessToken: family.accessToken,
      householdId: household,
      seniorId: seniorId(),
      providerId: provider.providerId,
      serviceKind: 'companion_dining',
    });
    await completeBooking(family.accessToken, booking.id);

    const completed = await waitForOutboxEvent(
      BOOKING_COMPLETED,
      (payload) => payload['bookingId'] === booking.id,
      { schema: 'booking' },
    );
    await waitForJournalBySourceEvent(admin.accessToken, completed.eventId);

    // All-time, unscoped. A period-scoped balance can net to zero by
    // containing nothing, and a visit completing near a month boundary is
    // exactly when that would happen.
    const trialBalance = await getTrialBalance(admin.accessToken);

    expect(trialBalance.imbalanceMinor).toBe(0);
    expect(trialBalance.totalDebitMinor).toBe(trialBalance.totalCreditMinor);

    // Guard against passing on an empty ledger: the assertion above is true of
    // a database with no journals in it at all.
    expect(trialBalance.totalDebitMinor).toBeGreaterThan(0);
    expect(trialBalance.rows.map((row) => row.accountCode)).toContain(ACCOUNT.providerPayable);
  });
});
