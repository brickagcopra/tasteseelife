import { Injectable } from '@nestjs/common';

/**
 * Resolves a subscription `planCode` (e.g. `family.tier2`) to the
 * pair of chart-of-accounts codes that back its revenue
 * recognition flow:
 *
 *   - Deferred Revenue sub-account (`2000.{planCode}`)
 *   - Subscription Revenue sub-account (`4000.{planCode}`)
 *
 * The mapping is a deterministic string concatenation per the
 * convention in `apps/service-accounting/src/modules/chart-of-accounts/seed-catalog.ts`:
 * every per-plan sub-account is `{parentCode}.{planCode}` where
 * `parentCode = 2000` (Deferred Revenue) or `4000` (Subscription
 * Revenue), and `planCode` matches `subscription.plans.code`.
 *
 * **Why this is a service, not a const.** Injectable so unit tests
 * can override; future per-customer-group dimensions (e.g.
 * partner-revenue with a different parent code) plug in without
 * touching callers.
 *
 * **The catalog is the authority — not this helper.** If a plan
 * lands without the matching accounts seeded, the journal post
 * fails downstream with `account_not_found` (TS-081 surfaces this
 * via the `PostJournalFailure` Result variant). The chart-of-
 * accounts seed (TS-080) is the source of truth; this helper just
 * names the accounts.
 *
 * **Why no defensive validation here.** `PlanCodeSchema` already
 * rejected malformed codes at the contract boundary; trusting the
 * already-validated input is correct.
 */
@Injectable()
export class PlanAccountResolverService {
  private static readonly DEFERRED_REVENUE_PARENT = '2000';
  private static readonly SUBSCRIPTION_REVENUE_PARENT = '4000';

  /**
   * Return the deferred + revenue account codes for the given
   * plan code.
   */
  resolve(planCode: string): {
    readonly deferredAccountCode: string;
    readonly revenueAccountCode: string;
  } {
    return {
      deferredAccountCode: `${PlanAccountResolverService.DEFERRED_REVENUE_PARENT}.${planCode}`,
      revenueAccountCode: `${PlanAccountResolverService.SUBSCRIPTION_REVENUE_PARENT}.${planCode}`,
    };
  }
}
