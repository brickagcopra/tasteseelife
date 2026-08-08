import {
  ProviderCertificationRecordSchema,
  ProviderTierHistoryRecordSchema,
  type ProviderCertificationRecord,
  type ProviderTierHistoryRecord,
} from '@taste-and-see/contracts';

import type { ProviderCertificationWithCatalog } from '../services/provider-certifications.service';
import type { ProviderTierHistoryRow } from '../services/tier-promotion.service';

/**
 * Row → DTO mappers for the certification + tier-history surfaces
 * (TS-052; extracted under TS-305a).
 *
 * **Why these moved out of the controller.** They were private to
 * `CertificationsController` until the admin provider dossier
 * (TS-305a) needed the same projections. A second copy would let the
 * provider's own view of a certification and the review committee's
 * view of the same certification drift — and the one place that must
 * never happen is a credential's `active` computation, which is the
 * whole point of the row. One mapper, two callers.
 */

/**
 * Project an issuance row (joined with its catalog entry) to the
 * wire DTO.
 *
 * `active` is computed at read time rather than stored, per the
 * schema's documented lifecycle: a cert is active when
 * `revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now)`.
 * `now` is injectable so callers composing a dossier can stamp every
 * row against a single instant — a list whose first row is evaluated
 * a few milliseconds before its last is a correctness hazard nobody
 * would ever debug.
 */
export function toProviderCertDto(
  record: ProviderCertificationWithCatalog,
  now: Date = new Date(),
): ProviderCertificationRecord {
  const { row, catalog } = record;
  const active =
    row.revokedAt === null && (row.expiresAt === null || row.expiresAt.getTime() > now.getTime());
  return ProviderCertificationRecordSchema.parse({
    id: row.id,
    providerId: row.providerId,
    certification: {
      id: catalog.id,
      code: catalog.code,
      name: catalog.name,
    },
    issuedAt: row.issuedAt.toISOString(),
    expiresAt: row.expiresAt !== null ? row.expiresAt.toISOString() : null,
    revokedAt: row.revokedAt !== null ? row.revokedAt.toISOString() : null,
    revocationReason: row.revocationReason,
    notes: row.notes,
    active,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

/**
 * Project an append-only tier-transition row to the wire DTO.
 */
export function toHistoryDto(row: ProviderTierHistoryRow): ProviderTierHistoryRecord {
  return ProviderTierHistoryRecordSchema.parse({
    id: row.id,
    providerId: row.providerId,
    fromTier: row.fromTier,
    toTier: row.toTier,
    reason: row.reason,
    triggeredByUserId: row.triggeredByUserId,
    notes: row.notes,
    occurredAt: row.occurredAt.toISOString(),
  });
}
