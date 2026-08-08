import { Injectable, Logger } from '@nestjs/common';
import type { ProviderMetricsSection } from '@taste-and-see/contracts';

import { PrismaService } from '../../../prisma/prisma.service';
import { computeMetricsSection, type BookingFactSummary } from '../metrics-computation';

/**
 * Read half of the provider metrics read model (TS-305d).
 *
 * Serves the single-provider figures the admin dossier and the 360
 * carry. Reads `provider_booking_facts` — NOT the `provider_metrics`
 * rollup — and the choice is deliberate in both directions:
 *
 *   - **The rolling window cannot come from the rollup.** A stored
 *     window figure is wrong the moment the clock passes its edge: a
 *     provider who stops working generates no event, so nothing
 *     recomputes their row, and they keep a flattering 90-day rate for
 *     ever. Deriving it from dated facts at read time cannot go stale.
 *   - **Nor can the median.** A rollup can hold a sum and a count, from
 *     which a mean is derivable; a median needs the distribution. PDD
 *     §8.2 asks for `response_time_p50` rather than a mean for the
 *     usual reason — one offer answered after a fortnight's holiday
 *     drags a mean far enough to misdescribe every other week.
 *
 * The rollup earns its place on the MANY-provider reads instead
 * (search ranking, the discovery document, a future
 * reliability-aware tier rule), where a per-provider aggregate would be
 * an N+1.
 *
 * **The fact read is not paginated, and here is the arithmetic.** The
 * table holds one row per booking per provider, and a provider is one
 * person: at five visits a day, every working day, for five years, that
 * is roughly 6,000 rows of six small columns. The narrow `select`
 * matters more than a limit would — and a limit would be worse than
 * useless, because a truncated read produces a *plausible wrong rate*
 * rather than an error (the failure mode TS-309b1 designed out of the
 * export seam). If the shape ever changes — an agency behind one
 * provider row, say — the answer is a pruning job or a windowed
 * lifetime, not a silent cap. → TS-305d-followup-3.
 */
@Injectable()
export class ProviderMetricsService {
  private readonly logger = new Logger(ProviderMetricsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * The metrics section for one provider.
   *
   * Never returns null and never throws for an unknown provider: a
   * provider with no facts yields `state: 'no_activity'`, which is a
   * true statement about them and the thing the surface needs to say.
   * A null would put the caller in the position of deciding whether it
   * means "unknown provider", "no bookings" or "read failed", and those
   * are three different sentences on a review page.
   *
   * `now` is injected so the window boundary is a parameter of the read
   * rather than a hidden dependency — the dossier passes its own single
   * clock, so every section of one dossier describes the same instant.
   */
  async getMetrics(providerId: string, now: Date = new Date()): Promise<ProviderMetricsSection> {
    if (providerId.length === 0) {
      return computeMetricsSection([], now);
    }

    const rows = await this.prisma.providerBookingFact.findMany({
      where: { providerId },
      select: {
        offeredAt: true,
        respondedAt: true,
        responseKind: true,
        declineKind: true,
        outcome: true,
        outcomeAt: true,
      },
    });

    const facts: BookingFactSummary[] = rows;
    const section = computeMetricsSection(facts, now);

    this.logger.log(
      {
        providerId,
        factCount: facts.length,
        lifetimeState: section.lifetime.state,
        recentState: section.recent.state,
      },
      'provider-metrics: section computed',
    );

    return section;
  }

  /**
   * The provider's lifetime completed-visit count, from the
   * `provider_metrics` rollup (TS-053-followup-4).
   *
   * **This is the read the rollup exists for.** It is called once per
   * provider by the discovery-snapshot projection, which the
   * search-indexer runs across the roster — so it must be a single
   * indexed row lookup, not an aggregate over that provider's facts.
   * The dossier goes the other way for the opposite reason: it needs a
   * window and a median, which a counter cannot give.
   *
   * Returns 0 for a provider with no rollup row. That is not a
   * placeholder: no row means no booking event has ever named them, so
   * zero completed visits is the true count. It is also what
   * `ProviderDiscoveryDocument` has carried, hard-coded, since TS-053 —
   * the difference now is that a non-zero answer is possible.
   *
   * Never throws for an unknown provider. A search projection that
   * failed because a provider has no bookings would take the whole
   * roster's indexing down for the newest people on it.
   */
  async getCompletedBookingCount(providerId: string): Promise<number> {
    if (providerId.length === 0) return 0;

    const row = await this.prisma.providerMetrics.findUnique({
      where: { providerId },
      select: { bookingsCompleted: true },
    });

    return row?.bookingsCompleted ?? 0;
  }
}
