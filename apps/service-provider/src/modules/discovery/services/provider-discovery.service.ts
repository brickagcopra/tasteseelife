import { Injectable, Logger } from '@nestjs/common';
import type {
  ProviderAvailabilitySummary,
  ProviderDiscoverySnapshotResponse,
} from '@taste-and-see/contracts';

import { PrismaService } from '../../../prisma/prisma.service';
import { ProviderMetricsService } from '../../metrics/services/provider-metrics.service';
import {
  AvailabilityService,
  resolveNextSevenDays,
} from '../../availability/services/availability.service';
import { CalendarSyncService } from '../../calendar-sync/services/calendar-sync.service';
import { ProviderCertificationsService } from '../../certifications/services/provider-certifications.service';
import {
  ServiceAreasService,
  resolveRepresentativeCentroid,
} from '../../service-areas/services/service-areas.service';

/**
 * Local mirror of the Prisma-generated `providers` row shape.
 * Same TS-051-followup-9 rationale documented elsewhere — we depend
 * on the shape, not the typed Prisma row, to dodge the namespace-
 * value-side resolution edge case under `verbatimModuleSyntax: false`.
 */
interface ProviderRowForSnapshot {
  readonly id: string;
  readonly userId: string;
  readonly status: 'pending' | 'in_review' | 'active' | 'suspended' | 'archived';
  readonly tier: 'basic' | 'certified' | 'elite';
  readonly displayName: string;
  readonly headline: string | null;
  readonly bio: string | null;
  readonly profilePhotoKey: string | null;
  readonly videoIntroKey: string | null;
  readonly timeZone: string;
  readonly updatedAt: Date;
  readonly deletedAt: Date | null;
}

/**
 * `ProviderDiscoveryService` — owns the read-only projection of a
 * provider row into the `ProviderDiscoveryDocument` shape consumed by
 * service-search (TS-053).
 *
 * The materialisation is read-only: this service never writes. Joins:
 *   - The `Provider` row provides the profile + tier + status +
 *     `time_zone` + media-key pointers + the `updatedAt` that drives
 *     the indexer's `sourceUpdatedAt` dedup axis.
 *   - `ProviderCertificationsService.listForProvider({activeOnly})`
 *     joined with catalog rows provides the `certifications` tag
 *     array (catalog `code`s — one tag per active issuance).
 *
 * **Fields with no backing column yet** (PRD §6.3 + §7.2 — landing
 * incrementally as the data model grows):
 *   - `languages` / `specialties` / `cuisines` / `dietaryExpertise` —
 *     default to empty arrays. These tables are deferred follow-ups
 *     of TS-052 (the discovery doc is forward-compatible; an empty
 *     array means "no specialty / language declared yet"). When the
 *     tables land, this service materialises from them; the contract
 *     doesn't change.
 *   - `centroid` — derived from `provider_service_areas` via
 *     `ServiceAreasService.getServiceAreas` (TS-053-followup-3). The
 *     provider's coverage polygons collapse into one representative
 *     point via `resolveRepresentativeCentroid` (area-weighted mean of
 *     the per-area centroids). A provider with no declared coverage
 *     returns `null`, which the search backend reads as "exclude from
 *     distance-sorted queries" (PRD §6.3). The search-indexer
 *     re-projects this on a `provider.service_areas_updated` event.
 *   - `completedBookingCount` — read from the `provider_metrics`
 *     rollup (TS-305d / TS-053-followup-4). A single indexed row
 *     lookup, deliberately, not an aggregate over that provider's
 *     booking facts: this projection runs across the whole roster when
 *     the indexer rebuilds, so the many-provider read is exactly what
 *     the rollup exists for. Zero for a provider no booking event has
 *     ever named, which is the true count rather than a placeholder.
 *
 *     **Known staleness, and it is bounded rather than silent.** The
 *     indexer re-projects on profile / certification / tier /
 *     availability / service-area events, and there is no event for
 *     "this provider completed a visit", so the indexed count lags
 *     until the next such edit. That is an improvement on the
 *     hard-coded 0 it replaces and it is not the end state —
 *     TS-053-followup-4a adds the emission.
 *   - `ratingAverage` / `ratingCount` — null / 0, and permanently so
 *     until ratings exist at all. Nothing on this platform captures
 *     one (TS-305e); these are not "no reviews yet", they are "we do
 *     not collect reviews". The `rating` sort option in the discovery
 *     contract therefore orders by nothing today.
 *
 * **Soft-deleted providers** surface as `kind: 'not_found'` so the
 * indexer issues a DELETE rather than an upsert (matches the
 * `Provider.deletedAt` convention from TS-050).
 */
@Injectable()
export class ProviderDiscoveryService {
  private readonly logger = new Logger(ProviderDiscoveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly certifications: ProviderCertificationsService,
    private readonly availability: AvailabilityService,
    private readonly serviceAreas: ServiceAreasService,
    private readonly calendarSync: CalendarSyncService,
    private readonly metrics: ProviderMetricsService,
  ) {}

  /**
   * Materialise the discovery snapshot for `providerId`. Returns
   * `kind: 'found'` with the full doc, or `kind: 'not_found'` when
   * the row does not exist or has been soft-deleted.
   */
  async getSnapshot(providerId: string): Promise<ProviderDiscoverySnapshotResponse> {
    const row = (await this.prisma.provider.findUnique({
      where: { id: providerId },
      select: {
        id: true,
        userId: true,
        status: true,
        tier: true,
        displayName: true,
        headline: true,
        bio: true,
        profilePhotoKey: true,
        videoIntroKey: true,
        timeZone: true,
        updatedAt: true,
        deletedAt: true,
      },
    })) as ProviderRowForSnapshot | null;

    if (row === null || row.deletedAt !== null) {
      this.logger.debug({ providerId }, 'provider-discovery.snapshot not_found');
      return { kind: 'not_found', providerId };
    }

    const activeCertifications = await this.certifications.listForProvider(row.id, {
      activeOnly: true,
    });
    const certificationCodes = activeCertifications.map((entry) => entry.catalog.code);

    const availabilitySummary = await this.buildAvailabilitySummary(row.id, row.timeZone);

    // TS-053-followup-3 — collapse the provider's coverage polygons into
    // one representative centroid for the distance-sort search. The row
    // is already confirmed live (the soft-delete / not-found guard above
    // returned early), so `getServiceAreas` returns an array (possibly
    // empty) rather than null; `resolveRepresentativeCentroid` maps an
    // empty set to null.
    const serviceAreas = await this.serviceAreas.getServiceAreas(row.id);
    const centroid = serviceAreas === null ? null : resolveRepresentativeCentroid(serviceAreas);

    // TS-053-followup-4 — the lifetime completed-visit count, from the
    // TS-305d rollup. One indexed row lookup: this projection runs
    // across the whole roster on an index rebuild, which is the
    // many-provider read the rollup was built for.
    const completedBookingCount = await this.metrics.getCompletedBookingCount(row.id);

    this.logger.debug(
      {
        providerId: row.id,
        tier: row.tier,
        status: row.status,
        certificationCount: certificationCodes.length,
        availabilityEntryCount: availabilitySummary?.entries.length ?? 0,
        serviceAreaCount: serviceAreas?.length ?? 0,
        hasCentroid: centroid !== null,
      },
      'provider-discovery.snapshot found',
    );

    return {
      kind: 'found',
      document: {
        providerId: row.id,
        userId: row.userId,
        displayName: row.displayName,
        headline: row.headline,
        bio: row.bio,
        tier: row.tier,
        status: row.status,
        // The five tag arrays default to empty in Phase 1 — see the
        // module-level doc-comment for the deferred-table rationale.
        languages: [],
        specialties: [],
        cuisines: [],
        dietaryExpertise: [],
        certifications: certificationCodes,
        centroid,
        // TS-305e: not "no reviews yet" but "we do not collect reviews".
        ratingAverage: null,
        ratingCount: 0,
        completedBookingCount,
        profilePhotoKey: row.profilePhotoKey,
        videoIntroKey: row.videoIntroKey,
        timeZone: row.timeZone,
        availabilitySummary,
        sourceUpdatedAt: row.updatedAt.toISOString(),
      },
    };
  }

  /**
   * TS-203 — Materialise the next-7-days availability projection
   * for the discovery doc. Returns `null` when the provider has not
   * declared any recurring windows (the search backend treats null
   * as "no schedule" and excludes the provider from the "available
   * this week" filter). When the provider has windows but every
   * upcoming day is blocked by exceptions, returns a non-null
   * summary with `entries: []` so consumers can distinguish
   * "no schedule" from "fully booked-out".
   */
  private async buildAvailabilitySummary(
    providerId: string,
    timeZone: string,
  ): Promise<ProviderAvailabilitySummary | null> {
    const snapshot = await this.availability.getAvailability(providerId);
    if (snapshot === null) return null;
    if (snapshot.windows.length === 0 && snapshot.exceptions.length === 0) return null;
    const generatedAt = new Date();
    // TS-206 — union the provider's connected external-calendar busy
    // intervals: a recurring window occurrence that overlaps an external
    // commitment is dropped from the projection. Empty (no connection /
    // no mirror) leaves the projection unchanged.
    const externalBusy = await this.calendarSync.getExternalBusyIntervals(providerId);
    const entries = resolveNextSevenDays({
      from: generatedAt,
      windows: snapshot.windows,
      exceptions: snapshot.exceptions,
      externalBusy,
      timeZone,
    });
    return {
      timeZone,
      entries: entries.map((entry) => ({ ...entry })),
      generatedAt: generatedAt.toISOString(),
    };
  }
}
