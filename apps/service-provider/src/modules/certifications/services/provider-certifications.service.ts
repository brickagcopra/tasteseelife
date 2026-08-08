import { Injectable, Logger } from '@nestjs/common';
import {
  PROVIDER_CERTIFICATION_GRANTED,
  PROVIDER_CERTIFICATION_REVOKED,
} from '@taste-and-see/contracts';
import { AuditEmitter, type AuditActorContext } from '@taste-and-see/nest-audit';
import { OutboxService, type OutboxRawExecutor } from '@taste-and-see/nest-outbox';
import { withSpan } from '@taste-and-see/tracing';

import { PrismaService, type PrismaTransactionClient } from '../../../prisma/prisma.service';

import {
  CertificationsCatalogService,
  type CertificationCatalogRecord,
} from './certifications-catalog.service';
import {
  CertificationsMetrics,
  certificationFailureOutcome,
  type ProviderCertificationOutcome,
} from './certifications-metrics';
import { PROVIDER_AUDIT_RESOURCE } from '../../audit/audit-resources';

import { err, ok, type Result } from './result';

/**
 * Local mirror of the Prisma-generated `provider_certifications`
 * row. Same TS-051-followup-9 rationale documented elsewhere.
 */
export interface ProviderCertificationRow {
  readonly id: string;
  readonly providerId: string;
  readonly certificationId: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date | null;
  readonly revokedAt: Date | null;
  readonly revocationReason: string | null;
  readonly issuerUserId: string | null;
  readonly revokerUserId: string | null;
  readonly notes: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Issuance row joined with its catalog row. The catalog row is
 * always non-null because the (provider, certification) FK is set at
 * grant time; a catalog entry may have flipped to `active = false`
 * after issuance but the row stays readable.
 */
export interface ProviderCertificationWithCatalog {
  readonly row: ProviderCertificationRow;
  readonly catalog: CertificationCatalogRecord;
}

export interface GrantCertificationInput {
  readonly providerId: string;
  readonly certificationCode: string;
  readonly issuedAt?: Date;
  /**
   * Explicit expiry override. `undefined` means "use the catalog's
   * default validity". `null` means "no expiry on this grant"
   * (overriding a catalog default).
   */
  readonly expiresAt?: Date | null;
  readonly issuerUserId?: string;
  readonly notes?: string;
  /**
   * TS-305a-followup-1 — the verified actor, built from the access token by
   * the controller. REQUIRED: a credential grant with no audit trail is
   * exactly the mutation CLAUDE.md §3.6 exists to make impossible, so the
   * type refuses to represent one.
   */
  readonly audit: AuditActorContext;
}

export interface RevokeCertificationInput {
  readonly providerCertificationId: string;
  readonly providerId: string;
  readonly revokerUserId?: string;
  readonly reason: string;
  /** TS-305a-followup-1 — see GrantCertificationInput.audit. */
  readonly audit: AuditActorContext;
}

/**
 * Failure shapes returned by `ProviderCertificationsService`.
 */
export type ProviderCertificationsFailure =
  | { readonly reason: 'invalid_request'; readonly message: string }
  | { readonly reason: 'provider_not_found'; readonly providerId: string }
  | { readonly reason: 'certification_not_found'; readonly certificationCode: string }
  | { readonly reason: 'already_active'; readonly providerCertificationId: string }
  | { readonly reason: 'not_found'; readonly providerCertificationId: string }
  | { readonly reason: 'already_revoked'; readonly providerCertificationId: string }
  | {
      readonly reason: 'outbox_validation_failed';
      readonly eventName: string;
      readonly message: string;
    };

/**
 * Thrown inside `prisma.$transaction` when `OutboxService.append`
 * returns `kind: 'validation_failed'`. The transaction-aware caller
 * rolls the surrounding state-change back and surfaces the failure as
 * a typed `outbox_validation_failed` `ProviderCertificationsFailure`
 * (mirrors `OutboxValidationFailedError` in service-subscription).
 *
 * Why throw inside the transaction rather than return: Prisma's
 * `$transaction` callback only rolls back on a thrown error, not on a
 * Result-shaped return value.
 */
class OutboxValidationFailedError extends Error {
  constructor(
    public readonly eventName: string,
    public readonly issues: ReadonlyArray<{
      readonly path: ReadonlyArray<string | number>;
      readonly message: string;
    }>,
  ) {
    super(`outbox.append validation failed for ${eventName}`);
    this.name = 'OutboxValidationFailedError';
  }
}

/**
 * `ProviderCertificationsService` — owns the per-provider issuance
 * log (TS-052).
 *
 * Surfaces:
 *  - `grant({providerId, certificationCode, ...})` — inserts a new
 *    `provider_certifications` row. Fails with `already_active` when
 *    the (provider, certification) pair already has a non-revoked,
 *    non-expired row.
 *  - `revoke({providerCertificationId, providerId, reason, ...})` —
 *    soft-deletes a row by setting `revoked_at` + `revocation_reason`.
 *    Idempotent at the row level (re-revoking returns
 *    `already_revoked`).
 *  - `listForProvider(providerId, {activeOnly?})` — returns issuance
 *    rows joined with catalog metadata, newest-first.
 *
 * **Tier-promotion side-effect is OUT OF SCOPE here**. The grant /
 * revoke methods don't recompute tier — the caller (admin controller)
 * follows up with a `TierPromotionService.evaluateAndApply` call to
 * close the loop. Keeping them decoupled lets admin tooling grant
 * credentials in advance of a tier change (e.g. issuing a cert
 * earned out-of-band while deferring promotion).
 *
 * **Tenant scoping** (CLAUDE.md §3.2). Methods require `providerId`
 * to be passed by the caller; the controller resolves it from the
 * authenticated user for self-service paths or from the route param
 * for admin paths. TS-141's Prisma extension will push enforcement
 * down a layer.
 *
 * **Idempotency**. Same-(provider, certification) double-grant
 * surfaces as `already_active`. Same-row double-revoke surfaces as
 * `already_revoked`. The HTTP layer wraps both writes in
 * `@Idempotent()` so a retried request with the same Idempotency-
 * Key returns the cached response.
 */
@Injectable()
export class ProviderCertificationsService {
  private readonly logger = new Logger(ProviderCertificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: CertificationsCatalogService,
    /**
     * TS-052-followup-1 — producer-side outbox SDK. Injected here so
     * `provider.certification_granted` / `provider.certification_revoked`
     * events append inside the same Prisma transaction as the
     * issuance-row write (the outbox invariant from PDD §7.3 /
     * CLAUDE.md §5.3).
     *
     * Provided by the global `OutboxModule` wired in `app.module.ts`.
     */
    private readonly outbox: OutboxService,
    /**
     * TS-305a-followup-1 — shared audit emission
     * (`@taste-and-see/nest-audit`). Emits inside the caller's transaction,
     * so an audit failure rolls the credential change back rather than
     * leaving a silent one.
     */
    private readonly audit: AuditEmitter,
    // Optional default (TS-052-followup-9) — the existing three-arg
    // unit-test call sites keep working; Nest injects the registered
    // provider in prod. No-op meter until `initMetrics` runs
    // (ApplicationsMetrics precedent).
    private readonly metrics: CertificationsMetrics = new CertificationsMetrics(),
  ) {}

  /**
   * Grant a certification to a provider. Returns the inserted row
   * joined with its catalog projection.
   *
   * Validation:
   *  - `providerId` must be non-empty AND reference an existing
   *    provider row (otherwise `provider_not_found`).
   *  - `certificationCode` must reference an **active** catalog row
   *    (otherwise `certification_not_found`).
   *  - The (provider, certification) pair must not already have an
   *    active row (otherwise `already_active`).
   *
   * Expiry derivation:
   *  - When `expiresAt` is `undefined` AND the catalog row has a
   *    non-null `default_validity_months`, the service computes
   *    `expiresAt = issuedAt + months`.
   *  - When `expiresAt` is explicitly `null`, no expiry is applied
   *    (overrides any catalog default).
   *  - When `expiresAt` is a Date, that date is used verbatim.
   */
  async grant(
    input: GrantCertificationInput,
  ): Promise<Result<ProviderCertificationWithCatalog, ProviderCertificationsFailure>> {
    return withSpan('provider.certification.grant', async (span) => {
      const startNs = process.hrtime.bigint();
      // Default to `error` so an unexpected throw records a bounded
      // outcome rather than mislabelling the sample.
      let outcome: ProviderCertificationOutcome = 'error';
      try {
        const result = await this.runGrant(input);
        outcome = result.ok ? 'ok' : certificationFailureOutcome(result.error);
        return result;
      } finally {
        const seconds = Number(process.hrtime.bigint() - startNs) / 1e9;
        span.setAttribute('provider.certification.outcome', outcome);
        this.metrics.recordGrant(outcome, seconds);
      }
    });
  }

  private async runGrant(
    input: GrantCertificationInput,
  ): Promise<Result<ProviderCertificationWithCatalog, ProviderCertificationsFailure>> {
    if (input.providerId.length === 0) {
      return err({ reason: 'invalid_request', message: 'providerId is required' });
    }
    if (input.certificationCode.length === 0) {
      return err({ reason: 'invalid_request', message: 'certificationCode is required' });
    }

    const provider = await this.prisma.provider.findUnique({
      where: { id: input.providerId },
      select: { id: true },
    });
    if (provider === null) {
      return err({ reason: 'provider_not_found', providerId: input.providerId });
    }

    const catalog = await this.catalog.findByCode(input.certificationCode);
    if (catalog === null) {
      return err({
        reason: 'certification_not_found',
        certificationCode: input.certificationCode,
      });
    }

    // Check for an existing active grant. "Active" is the same
    // definition the partial unique index enforces:
    // `revoked_at IS NULL`. Expiry is checked at the application
    // layer for the `already_active` short-circuit (an expired but
    // not-yet-revoked row counts as a "previous grant" — re-granting
    // creates a fresh row).
    const existingActive = (await this.prisma.providerCertification.findFirst({
      where: {
        providerId: input.providerId,
        certificationId: catalog.id,
        revokedAt: null,
      },
    })) as ProviderCertificationRow | null;

    const now = new Date();
    if (existingActive !== null) {
      const stillActive =
        existingActive.expiresAt === null || existingActive.expiresAt.getTime() > now.getTime();
      if (stillActive) {
        return err({ reason: 'already_active', providerCertificationId: existingActive.id });
      }
    }

    const issuedAt = input.issuedAt ?? now;
    const expiresAt = computeExpiresAt(catalog, issuedAt, input.expiresAt);

    // TS-052-followup-1 — persist the insert (and the auto-revoke of
    // any expired prior grant) + the outbox event atomically. Either
    // the row + the outbox row both land or neither does. The
    // `$transaction` rolls back when the outbox payload fails
    // validation (an `OutboxValidationFailedError` is thrown below);
    // we catch it on the outside and translate to a typed failure.
    try {
      const created = await this.prisma.$transaction(async (tx: PrismaTransactionClient) => {
        if (existingActive !== null) {
          // The row is expired but not revoked — soft-revoke it
          // before inserting the fresh grant so the partial unique
          // index doesn't refuse the new INSERT. We use a
          // system-actor revocation reason because the operator's
          // intent is a re-grant, not a disciplinary revoke. No
          // outbox event for the auto-revoke — operators see the
          // resulting grant event; the prior row is an internal
          // index-maintenance concern.
          await tx.providerCertification.update({
            where: { id: existingActive.id },
            data: {
              revokedAt: now,
              revocationReason: 'auto-revoked on regrant (prior grant expired)',
            },
          });
        }

        const inserted = (await tx.providerCertification.create({
          data: {
            providerId: input.providerId,
            certificationId: catalog.id,
            issuedAt,
            ...(expiresAt !== null ? { expiresAt } : {}),
            ...(input.issuerUserId !== undefined ? { issuerUserId: input.issuerUserId } : {}),
            ...(input.notes !== undefined ? { notes: input.notes } : {}),
          },
        })) as ProviderCertificationRow;

        const appended = await this.outbox.append(tx as unknown as OutboxRawExecutor, {
          eventName: PROVIDER_CERTIFICATION_GRANTED,
          eventId: `${inserted.id}.granted`,
          occurredAt: now,
          payload: {
            eventId: `${inserted.id}.granted`,
            occurredAt: now.toISOString(),
            providerId: input.providerId,
            providerCertificationId: inserted.id,
            certificationCode: catalog.code,
            issuedAt: issuedAt.toISOString(),
            expiresAt: expiresAt !== null ? expiresAt.toISOString() : null,
            issuerUserId: input.issuerUserId ?? null,
          },
        });
        if (appended.kind !== 'appended') {
          throw new OutboxValidationFailedError(appended.eventName, appended.issues);
        }

        // TS-305a-followup-1 — audited in the SAME transaction as the grant
        // (CLAUDE.md §3.6, §5.3). An audit failure rolls the grant back:
        // an unaudited credential grant must not be representable.
        await this.audit.emit(tx as unknown as OutboxRawExecutor, input.audit, {
          action: 'provider_certification:grant',
          resourceKind: PROVIDER_AUDIT_RESOURCE.certification,
          resourceId: inserted.id,
          before: null,
          after: auditCertSnapshot(inserted, catalog.code),
        });

        return inserted;
      });

      this.logger.log(
        {
          providerCertificationId: created.id,
          providerId: input.providerId,
          certificationCode: catalog.code,
          issuerUserId: input.issuerUserId ?? null,
          expiresAt: created.expiresAt?.toISOString() ?? null,
        },
        'provider-certification.grant ok',
      );

      return ok({ row: created, catalog });
    } catch (e) {
      if (e instanceof OutboxValidationFailedError) {
        this.logger.error(
          { eventName: e.eventName, issues: e.issues },
          'provider-certification.grant outbox validation failed; tx rolled back',
        );
        return err({
          reason: 'outbox_validation_failed',
          eventName: e.eventName,
          message: `event ${e.eventName} payload failed validation`,
        });
      }
      throw e;
    }
  }

  /**
   * Revoke an issuance by id. Returns the updated row joined with
   * its catalog projection.
   *
   * Validation:
   *  - The row must exist and belong to `providerId` (otherwise
   *    `not_found`; the controller surfaces a generic 404 either
   *    way to avoid leaking ownership).
   *  - The row must not already be revoked (otherwise
   *    `already_revoked` — the caller can read the row to confirm
   *    no-op).
   */
  async revoke(
    input: RevokeCertificationInput,
  ): Promise<Result<ProviderCertificationWithCatalog, ProviderCertificationsFailure>> {
    return withSpan('provider.certification.revoke', async (span) => {
      const startNs = process.hrtime.bigint();
      let outcome: ProviderCertificationOutcome = 'error';
      try {
        const result = await this.runRevoke(input);
        outcome = result.ok ? 'ok' : certificationFailureOutcome(result.error);
        return result;
      } finally {
        const seconds = Number(process.hrtime.bigint() - startNs) / 1e9;
        span.setAttribute('provider.certification.outcome', outcome);
        this.metrics.recordRevoke(outcome, seconds);
      }
    });
  }

  private async runRevoke(
    input: RevokeCertificationInput,
  ): Promise<Result<ProviderCertificationWithCatalog, ProviderCertificationsFailure>> {
    if (input.providerCertificationId.length === 0) {
      return err({
        reason: 'invalid_request',
        message: 'providerCertificationId is required',
      });
    }
    if (input.providerId.length === 0) {
      return err({ reason: 'invalid_request', message: 'providerId is required' });
    }
    if (input.reason.length === 0) {
      return err({ reason: 'invalid_request', message: 'reason is required' });
    }

    const existing = (await this.prisma.providerCertification.findUnique({
      where: { id: input.providerCertificationId },
    })) as ProviderCertificationRow | null;

    if (existing === null || existing.providerId !== input.providerId) {
      return err({
        reason: 'not_found',
        providerCertificationId: input.providerCertificationId,
      });
    }
    if (existing.revokedAt !== null) {
      return err({
        reason: 'already_revoked',
        providerCertificationId: existing.id,
      });
    }

    const catalog = await this.catalog.findById(existing.certificationId);
    if (catalog === null) {
      // Catalog row was hard-deleted — should not happen because the
      // seed never deletes rows. Surface as a server-error path
      // rather than fabricating a row.
      this.logger.error(
        {
          providerCertificationId: existing.id,
          certificationId: existing.certificationId,
        },
        'provider-certification.revoke: catalog row missing',
      );
      return err({ reason: 'not_found', providerCertificationId: existing.id });
    }

    const now = new Date();

    // TS-052-followup-1 — persist the revoke + the outbox event
    // atomically. Same shape as `grant` above.
    try {
      const updated = await this.prisma.$transaction(async (tx: PrismaTransactionClient) => {
        const row = (await tx.providerCertification.update({
          where: { id: existing.id },
          data: {
            revokedAt: now,
            revocationReason: input.reason,
            ...(input.revokerUserId !== undefined ? { revokerUserId: input.revokerUserId } : {}),
          },
        })) as ProviderCertificationRow;

        const appended = await this.outbox.append(tx as unknown as OutboxRawExecutor, {
          eventName: PROVIDER_CERTIFICATION_REVOKED,
          eventId: `${row.id}.revoked`,
          occurredAt: now,
          payload: {
            eventId: `${row.id}.revoked`,
            occurredAt: now.toISOString(),
            providerId: existing.providerId,
            providerCertificationId: row.id,
            certificationCode: catalog.code,
            revocationReason: input.reason,
            revokerUserId: input.revokerUserId ?? null,
          },
        });
        if (appended.kind !== 'appended') {
          throw new OutboxValidationFailedError(appended.eventName, appended.issues);
        }

        // TS-305a-followup-1 — see grant. `before` is the pre-revoke snapshot
        // captured OUTSIDE the transaction, so the diff shows what was taken
        // away rather than the post-write row twice.
        await this.audit.emit(tx as unknown as OutboxRawExecutor, input.audit, {
          action: 'provider_certification:revoke',
          resourceKind: PROVIDER_AUDIT_RESOURCE.certification,
          resourceId: row.id,
          before: auditCertSnapshot(existing, catalog.code),
          after: auditCertSnapshot(row, catalog.code),
        });

        return row;
      });

      this.logger.log(
        {
          providerCertificationId: existing.id,
          providerId: existing.providerId,
          revokerUserId: input.revokerUserId ?? null,
        },
        'provider-certification.revoke ok',
      );

      return ok({ row: updated, catalog });
    } catch (e) {
      if (e instanceof OutboxValidationFailedError) {
        this.logger.error(
          { eventName: e.eventName, issues: e.issues },
          'provider-certification.revoke outbox validation failed; tx rolled back',
        );
        return err({
          reason: 'outbox_validation_failed',
          eventName: e.eventName,
          message: `event ${e.eventName} payload failed validation`,
        });
      }
      throw e;
    }
  }

  /**
   * Return every issuance row for a provider, joined with catalog
   * projections, ordered by `issued_at DESC`. When `activeOnly` is
   * true (the default for the provider-portal self-view), only
   * non-revoked, non-expired rows are returned.
   */
  async listForProvider(
    providerId: string,
    options: { readonly activeOnly?: boolean; readonly now?: Date } = {},
  ): Promise<readonly ProviderCertificationWithCatalog[]> {
    if (providerId.length === 0) return [];

    const now = options.now ?? new Date();
    const activeOnly = options.activeOnly ?? false;

    const rows = (await this.prisma.providerCertification.findMany({
      where: activeOnly
        ? {
            providerId,
            revokedAt: null,
            OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
          }
        : { providerId },
      orderBy: { issuedAt: 'desc' },
    })) as ProviderCertificationRow[];

    if (rows.length === 0) return [];

    const ids = Array.from(new Set(rows.map((r) => r.certificationId)));
    const catalogMap = await this.catalog.findManyByIds(ids);

    const result: ProviderCertificationWithCatalog[] = [];
    for (const row of rows) {
      const catalog = catalogMap.get(row.certificationId);
      if (catalog === undefined) {
        // Skip rows whose catalog row vanished — same edge case
        // documented on revoke. Logged at warn so ops notices.
        this.logger.warn(
          {
            providerCertificationId: row.id,
            certificationId: row.certificationId,
          },
          'provider-certification.list: catalog row missing',
        );
        continue;
      }
      result.push({ row, catalog });
    }
    return result;
  }

  /**
   * Return the active gate certifications for a provider, projected
   * into a set of catalog codes. Used by `TierPromotionService` to
   * evaluate tier eligibility without re-fetching catalog rows.
   */
  async listActiveCodes(providerId: string, now: Date = new Date()): Promise<ReadonlySet<string>> {
    const records = await this.listForProvider(providerId, { activeOnly: true, now });
    const codes = new Set<string>();
    for (const record of records) {
      codes.add(record.catalog.code);
    }
    return codes;
  }
}

/**
 * Derive `expiresAt` for a new grant. `null` (no expiry) when the
 * caller explicitly opts out OR the catalog has no default. A Date
 * is returned when the caller supplied one OR when the catalog's
 * default-validity-months is non-null and the caller did not opt
 * out.
 */
function computeExpiresAt(
  catalog: CertificationCatalogRecord,
  issuedAt: Date,
  override: Date | null | undefined,
): Date | null {
  if (override === null) return null;
  if (override !== undefined) return override;
  if (catalog.defaultValidityMonths === null) return null;
  return addMonths(issuedAt, catalog.defaultValidityMonths);
}

function addMonths(base: Date, months: number): Date {
  const result = new Date(base.getTime());
  result.setUTCMonth(result.getUTCMonth() + months);
  return result;
}

/**
 * Minimal certification snapshot for the audit diff (TS-305a-followup-1).
 *
 * Deliberately NOT the full row: the audit log is append-only and long-lived,
 * and the fields that matter to a reviewer are what credential it was, when it
 * ran from and to, and whether it was revoked and why. The free-text
 * `notes` field is included because a granter's justification IS the record;
 * nothing else on the row carries meaning a year later.
 */
function auditCertSnapshot(
  row: ProviderCertificationRow,
  certificationCode: string,
): Record<string, unknown> {
  return {
    id: row.id,
    providerId: row.providerId,
    certificationCode,
    issuedAt: row.issuedAt.toISOString(),
    expiresAt: row.expiresAt !== null ? row.expiresAt.toISOString() : null,
    revokedAt: row.revokedAt !== null ? row.revokedAt.toISOString() : null,
    revocationReason: row.revocationReason,
    issuerUserId: row.issuerUserId,
    revokerUserId: row.revokerUserId,
    notes: row.notes,
  };
}
