import { Injectable, Logger, Optional } from '@nestjs/common';
import type {
  AcademyCertificationStatus,
  AcademyCourseTrack,
  CertificationRenewalCandidate,
  ExpireCertificationResponse,
} from '@taste-and-see/contracts';

import { PrismaService } from '../../../prisma/prisma.service';

/**
 * The certification row as projected for the renewal surfaces. Local row
 * interface + `as` cast is the codebase-wide Prisma-namespace workaround
 * (TS-021-followup-2/-3; mirrors `CertificationService`); switch to the
 * `@prisma/client` model type on the next Prisma minor bump.
 */
interface RenewalRow {
  readonly id: string;
  readonly studentUserId: string;
  readonly holderName: string | null;
  readonly courseId: string;
  readonly title: string;
  readonly track: AcademyCourseTrack;
  readonly issuedAt: Date;
  readonly expiresAt: Date | null;
}

const RENEWAL_SELECT = {
  id: true,
  studentUserId: true,
  holderName: true,
  courseId: true,
  title: true,
  track: true,
  issuedAt: true,
  expiresAt: true,
} as const;

const MS_PER_DAY = 86_400_000;

export interface ListRenewalCandidatesInput {
  readonly cursor: string | undefined;
  readonly limit: number;
  readonly horizonDays: number;
}

export interface ListRenewalCandidatesResult {
  readonly certifications: readonly CertificationRenewalCandidate[];
  readonly nextCursor: string | null;
}

/**
 * Certification-renewal read + lapse-write service (TS-256; PRD §9.3; PDD
 * §15.2). Sole consumer is the renewal-reminder worker over a
 * shared-secret-pinned internal call.
 *
 * Two operations:
 *   - `listRenewalCandidates` — the cross-student batch of ACTIVE
 *     certifications whose `expiresAt` is already past OR within
 *     `horizonDays`. Keyset-paginated by id so the worker walks the whole
 *     at-risk population in bounded pages. The worker derives the
 *     reminder milestone (or the lapsed state) from each row's `expiresAt`.
 *   - `expireCertification` — the idempotent lapse flip. Only an ACTIVE
 *     certification whose expiry is genuinely past flips to `expired`; an
 *     already-`expired` / terminal `revoked` certification, or one not yet
 *     past expiry, is a no-op. The status flip is the "course.completed
 *     reversal" trigger point (PRD §9.3) — the downstream provider-tier
 *     demotion is the deferred TS-256-followup-1 (service-academy has no
 *     outbox yet; TS-255-followup-4 owns the provider-svc sync).
 *
 * The clock is injected (the `CertificationService` precedent) so the
 * horizon cutoff + the lapse check are deterministic under test.
 */
@Injectable()
export class CertificationRenewalsService {
  private readonly logger = new Logger(CertificationRenewalsService.name);

  constructor(
    private readonly prisma: PrismaService,
    // `@Optional()` is load-bearing, not decoration (TS-506). A default
    // parameter value does NOT make Nest skip the parameter: it reads
    // `design:paramtypes`, sees `Function`, and tries to resolve a provider
    // by that token — which no module declares, so the whole service failed
    // to construct and `service-academy` died in the injector before binding
    // a port. With `@Optional()` Nest injects `undefined` and the default
    // applies, which is what this test seam always meant.
    @Optional() private readonly now: () => Date = () => new Date(),
  ) {}

  async listRenewalCandidates(
    input: ListRenewalCandidatesInput,
  ): Promise<ListRenewalCandidatesResult> {
    const cutoff = new Date(this.now().getTime() + input.horizonDays * MS_PER_DAY);

    const where: {
      status: AcademyCertificationStatus;
      expiresAt: { not: null; lte: Date };
      id?: { gt: string };
    } = {
      status: 'active',
      // `not: null` keeps the index predicate honest — only expiry-bearing
      // certifications can be at-risk; `lte: cutoff` bounds the forward scan.
      expiresAt: { not: null, lte: cutoff },
    };
    if (input.cursor !== undefined) where.id = { gt: input.cursor };

    // Over-fetch one row to detect a further page without a second count
    // query (the booking-dashboard keyset precedent).
    const rows = (await this.prisma.academyCertification.findMany({
      where,
      orderBy: { id: 'asc' },
      take: input.limit + 1,
      select: RENEWAL_SELECT,
    })) as RenewalRow[];

    const hasMore = rows.length > input.limit;
    const page = hasMore ? rows.slice(0, input.limit) : rows;
    const lastRow = page.at(-1);
    const nextCursor = hasMore && lastRow !== undefined ? lastRow.id : null;

    return { certifications: page.map(toCandidate), nextCursor };
  }

  /**
   * Mark a lapsed certification expired. Returns `null` when the
   * certification does not exist (the controller maps that to 404).
   */
  async expireCertification(id: string): Promise<ExpireCertificationResponse | null> {
    const row = (await this.prisma.academyCertification.findFirst({
      where: { id },
      select: { id: true, status: true, expiresAt: true },
    })) as { id: string; status: AcademyCertificationStatus; expiresAt: Date | null } | null;
    if (row === null) return null;

    // Idempotent + safe: only flip an ACTIVE certification whose expiry is
    // genuinely past. A terminal `revoked` / already-`expired` row, or an
    // active row not yet at expiry, is a no-op — so a worker bug can never
    // prematurely expire a live credential.
    const isPastExpiry = row.expiresAt !== null && row.expiresAt.getTime() <= this.now().getTime();
    if (row.status !== 'active' || !isPastExpiry) {
      return { certificationId: id, status: row.status, changed: false };
    }

    const updated = (await this.prisma.academyCertification.update({
      where: { id },
      data: { status: 'expired' },
      select: { id: true, status: true },
    })) as { id: string; status: AcademyCertificationStatus };

    this.logger.log(
      { certificationId: id, expiresAt: row.expiresAt?.toISOString() ?? null },
      'academy certification lapsed → expired (TS-256)',
    );
    return { certificationId: id, status: updated.status, changed: true };
  }
}

/** Project a renewal row into the wire `CertificationRenewalCandidate`. */
function toCandidate(row: RenewalRow): CertificationRenewalCandidate {
  // `expiresAt` is non-null by the `not: null` filter, but the row type
  // carries the column's nullable shape — assert to a concrete ISO string.
  const expiresAt = row.expiresAt;
  if (expiresAt === null) {
    // Unreachable given the query filter; guard so the contract invariant
    // (non-null `expiresAt`) is enforced at the projection boundary.
    throw new Error(`renewal candidate ${row.id} has a null expiresAt`);
  }
  return {
    certificationId: row.id,
    studentUserId: row.studentUserId,
    holderName: row.holderName,
    courseId: row.courseId,
    courseTitle: row.title,
    track: row.track,
    issuedAt: row.issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
}
