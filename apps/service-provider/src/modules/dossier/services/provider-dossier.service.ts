import { Injectable, Logger } from '@nestjs/common';
import type {
  ProviderDossierBackgroundCheck,
  ProviderMetricsSection,
} from '@taste-and-see/contracts';

import { PrismaService } from '../../../prisma/prisma.service';
import { toHistoryDto, toProviderCertDto } from '../../certifications/mappers/certification.mapper';
import { ProviderCertificationsService } from '../../certifications/services/provider-certifications.service';
import { TierPromotionService } from '../../certifications/services/tier-promotion.service';
import { ProviderMetricsService } from '../../metrics/services/provider-metrics.service';
import {
  ProviderProfileService,
  type ProviderProfileSnapshot,
} from '../../profile/services/provider-profile.service';

/**
 * Row shape for the background-check projection.
 *
 * Deliberately five columns wide. `provider_background_checks` also
 * holds `checkr_candidate_id`, `checkr_report_id`, `last_event_id`
 * and the AES-GCM `payload_*` quartet — the consumer report and its
 * handles. The dossier query projects them out at the SQL layer
 * rather than mapping them away afterwards, so the report never
 * enters this process's memory on this code path at all. A leak here
 * would have to be written on purpose.
 */
interface DossierBackgroundCheckRow {
  readonly id: string;
  readonly status: ProviderDossierBackgroundCheck['status'];
  readonly completedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Assembled dossier, still in row/DTO-mixed form. The controller
 * projects `provider` to the wire DTO (it owns the ISO-string
 * conversion, matching the rest of this service); the certification
 * and tier-history sections are already DTOs because their mappers
 * are shared with the certifications controller.
 */
export interface ProviderDossierSnapshot {
  readonly profile: ProviderProfileSnapshot;
  readonly certifications: ReturnType<typeof toProviderCertDto>[];
  readonly tierHistory: ReturnType<typeof toHistoryDto>[];
  readonly backgroundCheck: ProviderDossierBackgroundCheck | null;
  /**
   * TS-305d. Already a wire DTO — the metrics service owns its own
   * ISO-string conversion because the section's shape is the contract's
   * discriminated union, not a row.
   */
  readonly metrics: ProviderMetricsSection;
}

/**
 * Admin provider dossier assembly (TS-305a; PRD §10.14, PDD §16.1).
 *
 * Reads only — this service writes nothing and emits no events. It
 * composes three existing in-service reads plus one narrow projection:
 *
 *   1. `ProviderProfileService.getProfile` — the provider row + tags.
 *   2. `ProviderCertificationsService.listForProvider` — the FULL
 *      issuance history (`activeOnly: false`). A revoked credential
 *      is the single most relevant row on a review surface; the
 *      provider's own self-view filters those out, this one must not.
 *   3. `TierPromotionService.getHistory` — the append-only transition
 *      log.
 *   4. The most recent `provider_background_checks` row, projected to
 *      its verdict.
 *
 * **Archived providers are served.** `getProfile` returns soft-deleted
 * rows; unlike the public profile GET, the dossier does not 404 them.
 * A committee convened about a provider who was archived last month
 * needs exactly that row.
 *
 * **One clock for the whole dossier.** `now` is captured once and
 * threaded into every certification's `active` computation, so a
 * dossier can never report a credential as active in one row and
 * expired in the next because the list took a few milliseconds to
 * map.
 *
 * **The four reads are issued concurrently.** They are independent and
 * all four must succeed; `Promise.all` keeps the endpoint at one
 * round-trip's latency rather than four. There is no cross-read
 * consistency guarantee and none is needed — nothing here is a
 * balance.
 */
@Injectable()
export class ProviderDossierService {
  private readonly logger = new Logger(ProviderDossierService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly profile: ProviderProfileService,
    private readonly certifications: ProviderCertificationsService,
    private readonly tier: TierPromotionService,
    private readonly metrics: ProviderMetricsService,
  ) {}

  /**
   * Assemble the dossier for `providerId`, or `null` when no provider
   * row exists. The caller maps null to 404.
   */
  async getDossier(
    providerId: string,
    now: Date = new Date(),
  ): Promise<ProviderDossierSnapshot | null> {
    if (providerId.length === 0) return null;

    const profile = await this.profile.getProfile(providerId);
    if (profile === null) {
      return null;
    }

    const [certifications, tierHistory, backgroundCheck, metrics] = await Promise.all([
      this.certifications.listForProvider(providerId, { activeOnly: false, now }),
      this.tier.getHistory(providerId),
      this.findLatestBackgroundCheck(providerId),
      // TS-305d. `now` is the dossier's single clock, threaded in for
      // the same reason the certifications take it: the rolling window's
      // boundary and a credential's `active` flag must describe one
      // instant, or a screenshotted deliberation page can disagree with
      // itself by a few milliseconds' worth of midnight.
      this.metrics.getMetrics(providerId, now),
    ]);

    if (backgroundCheck === null) {
      // Not an error — a legacy provider, or an application that never
      // reached the Checkr call. Logged at info because "no check on
      // file" is a finding a reviewer will be asked about, and the
      // trail should show the dossier reported it rather than lost it.
      this.logger.log({ providerId }, 'provider-dossier: no background check on file for provider');
    }

    return {
      profile,
      certifications: certifications.map((record) => toProviderCertDto(record, now)),
      tierHistory: tierHistory.map(toHistoryDto),
      backgroundCheck,
      metrics,
    };
  }

  /**
   * Most recent background check for the provider, projected to the
   * verdict fields only. Ordered by `created_at DESC` over the
   * `provider_background_checks_provider_recent_idx` index.
   */
  private async findLatestBackgroundCheck(
    providerId: string,
  ): Promise<ProviderDossierBackgroundCheck | null> {
    const row = (await this.prisma.providerBackgroundCheck.findFirst({
      where: { providerId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        status: true,
        completedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    })) as DossierBackgroundCheckRow | null;

    if (row === null) return null;

    return {
      id: row.id,
      status: row.status,
      completedAt: row.completedAt !== null ? row.completedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
