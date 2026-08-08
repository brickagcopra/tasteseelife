import { Injectable, Logger } from '@nestjs/common';
import {
  AccountCurrencySchema,
  type CreateConciergeBookingRequest,
} from '@taste-and-see/contracts';

import { err, ok, type Result } from '../../../common/result';
import {
  BookingsService,
  type BookingRecord,
  type BookingsServiceFailure,
} from '../../bookings/services/bookings.service';
import { CatalogService } from '../../catalog/services/catalog.service';
import { getServiceKindDefault } from './service-kind-defaults';

export interface CreateConciergeRequestInput {
  readonly actorUserId: string;
  readonly request: CreateConciergeBookingRequest;
}

/**
 * Concierge-request orchestrator (TS-125).
 *
 * Translates a family-friendly Phase-1 booking request — one that
 * carries no money fields — into the canonical `CreateBookingRequest`
 * shape `BookingsService.createBooking` consumes; the booking is created
 * in `pending` for concierge fulfilment.
 *
 * **Pricing source (TS-060-followup-2a).** `basePrice` + `currency` are
 * read from the admin-editable `service_catalog` table via
 * `CatalogService.getByKind` (in-process — same service). For Phase 1
 * the quote anchors on the band *floor* (`baseRateMinMinor`); the band
 * end the provider tier selects arrives with TS-125-followup-8. When the
 * catalog has no row for the kind (a not-yet-seeded environment), we
 * fall back to the frozen `service-kind-defaults.ts` constant — the seed
 * anchors the band floor on that same constant, so the fallback is
 * numerically identical, it just guards an unseeded env. The commission
 * rate stays sourced from the constant: the catalog carries no
 * commission column (rate is tier-derived, TS-125-followup-8), so the
 * constant remains the platform-default until that lands.
 *
 * Thin wrapper by design — the heavy lifting (outbox event, tier
 * gating, transactional consistency) lives in `BookingsService`. This
 * layer's only job is the contract translation + the price lookup.
 */
@Injectable()
export class ConciergeRequestsService {
  private readonly logger = new Logger(ConciergeRequestsService.name);

  constructor(
    private readonly bookings: BookingsService,
    private readonly catalog: CatalogService,
  ) {}

  async createRequest(
    input: CreateConciergeRequestInput,
  ): Promise<Result<BookingRecord, BookingsServiceFailure>> {
    const kind = input.request.serviceKind;
    const defaults = getServiceKindDefault(kind);
    const catalogEntry = await this.catalog.getByKind(kind);

    // Prefer the admin-editable catalog row; fall back to the frozen
    // constant when the catalog has not been seeded for this kind. The
    // commission rate is always the constant's (the catalog has no
    // commission column — tier-aware rate is TS-125-followup-8).
    const basePriceMinor = catalogEntry?.baseRateMinMinor ?? defaults.basePriceMinor;
    // TS-060-followup-1b — the booking contract now allow-lists currency
    // to USD (Phase-1, PRD §11.4). Both sources are USD by construction
    // (the catalog upsert rejects non-USD; the service-kind defaults are
    // USD constants), so narrowing through the same allow-list is a
    // server-side invariant assert: a stored non-USD value is a data-
    // integrity bug and surfaces loudly rather than silently round-tripping
    // into a booking the commission recognizer (TS-083) would later reject.
    const currency = AccountCurrencySchema.parse(catalogEntry?.currency ?? defaults.currency);
    const priceSource = catalogEntry === null ? 'constant' : 'catalog';

    if (catalogEntry === null) {
      this.logger.warn(
        `concierge.request.catalog_miss serviceKind=${kind} — service_catalog has no row; falling back to service-kind-defaults constant`,
      );
    }

    this.logger.log(
      `concierge.request.received actorUserId=${input.actorUserId} householdId=${input.request.householdId} providerId=${input.request.providerId} serviceKind=${kind} basePriceMinor=${basePriceMinor} priceSource=${priceSource}`,
    );
    const result = await this.bookings.createBooking({
      actorUserId: input.actorUserId,
      request: {
        householdId: input.request.householdId,
        seniorId: input.request.seniorId,
        providerId: input.request.providerId,
        serviceKind: kind,
        scheduledStart: input.request.scheduledStart,
        scheduledEnd: input.request.scheduledEnd,
        currency,
        basePriceMinor,
        commissionRateBps: defaults.commissionRateBps,
        ...(input.request.bookingNotes !== undefined && {
          bookingNotes: input.request.bookingNotes,
        }),
        // TS-217-prep-4c — forward the originating search-correlation token so
        // `booking.created` echoes it for precise per-search conversion.
        ...(input.request.searchId !== undefined && {
          searchId: input.request.searchId,
        }),
      },
    });
    if (!result.ok) {
      return err(result.error);
    }
    return ok(result.value);
  }
}
