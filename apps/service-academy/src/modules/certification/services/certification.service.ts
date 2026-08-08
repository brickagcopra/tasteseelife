import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type {
  AcademyCertificationRecord,
  AcademyCertificationStatus,
  AcademyCourseTrack,
  IssueAcademyCertificationRequest,
  ListAcademyCertificationsQuery,
  PublicCertificationVerification,
} from '@taste-and-see/contracts';
import { ACADEMY_CERTIFICATION_EXPIRES_IN_MONTHS_DEFAULT } from '@taste-and-see/contracts';

import { ENV_TOKEN } from '../../../config/config.module';
import type { Env } from '../../../config/env';
import { PrismaService } from '../../../prisma/prisma.service';
import { CertificatePdfStore } from './certificate-pdf-store';
import { renderCertificatePdf, type CertificateFacts } from './certificate-pdf';
import { generateVerificationToken } from './verification-token';

/**
 * The certification row as projected by the explicit `select` below. Local row
 * interface + `as` cast is the codebase-wide Prisma-namespace workaround
 * (TS-021-followup-2/-3); switch to the `@prisma/client` model type on the next
 * Prisma minor bump (TS-255-followup-8 mirrors TS-254-followup-8).
 */
interface CertificationRow {
  readonly id: string;
  readonly studentUserId: string;
  readonly courseId: string;
  readonly enrollmentId: string | null;
  readonly title: string;
  readonly track: AcademyCourseTrack;
  readonly holderName: string | null;
  readonly status: AcademyCertificationStatus;
  readonly verificationToken: string;
  readonly certificatePdfKey: string | null;
  readonly issuedAt: Date;
  readonly expiresAt: Date | null;
  readonly revokedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const CERTIFICATION_SELECT = {
  id: true,
  studentUserId: true,
  courseId: true,
  enrollmentId: true,
  title: true,
  track: true,
  holderName: true,
  status: true,
  verificationToken: true,
  certificatePdfKey: true,
  issuedAt: true,
  expiresAt: true,
  revokedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

export type IssueCertificationOutcome =
  | {
      readonly ok: true;
      readonly created: boolean;
      readonly certification: AcademyCertificationRecord;
    }
  | { readonly ok: false; readonly reason: 'course_not_found' }
  | { readonly ok: false; readonly reason: 'enrollment_not_found' }
  | { readonly ok: false; readonly reason: 'enrollment_not_completed' };

export type RevokeCertificationOutcome =
  | { readonly ok: true; readonly certification: AcademyCertificationRecord }
  | { readonly ok: false; readonly reason: 'not_found' }
  | { readonly ok: false; readonly reason: 'already_revoked' };

/**
 * Academy certification service (TS-255; PRD §9.3; PDD §15.2).
 *
 * Issues a certification on course completion + assessment passage: it
 * snapshots the course `title` + `track` + the supplied `holderName`, mints an
 * unguessable verification token, renders the PDF (`pdfkit`), stores it
 * (stub-mode S3 today — TS-255-followup-2), and stamps a renewal expiry
 * (default 24 months, PDD §15.2). Reads support the admin management surface +
 * the PUBLIC `/verify/cert/{token}` page (the controller wraps the public read
 * in `runWithoutTenantContext` — `AcademyCertification` is tenant-scoped).
 *
 * **Cross-service discipline (CLAUDE.md §2.3):** the holder's name lives in
 * `identity.users`; it is NEVER joined — the caller supplies it and the service
 * snapshots it, so render + verify need no cross-service hop. The
 * provider-tier-eligibility sync (`provider-svc`, PDD §15.2) is the carved
 * follow-up TS-255-followup-4.
 *
 * The clock / token factory / PDF renderer are injected (defaulting to the real
 * implementations — the `quiz-attempt.service` precedent) so issuance is
 * deterministic under test without invoking `pdfkit`.
 */
@Injectable()
export class CertificationService {
  private readonly logger = new Logger(CertificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pdfStore: CertificatePdfStore,
    @Inject(ENV_TOKEN) private readonly env: Env,
    // `@Optional()` is load-bearing, not decoration (TS-506). A default
    // parameter value does NOT make Nest skip the parameter: it reads
    // `design:paramtypes`, sees `Function`, and tries to resolve a provider
    // by that token — which no module declares, so the whole service failed
    // to construct and `service-academy` died in the injector before binding
    // a port. With `@Optional()` Nest injects `undefined` and the default
    // applies, which is what this test seam always meant.
    @Optional() private readonly now: () => Date = () => new Date(),
    @Optional() private readonly tokenFactory: () => string = generateVerificationToken,
    @Optional()
    private readonly renderPdf: (facts: CertificateFacts) => Promise<Buffer> = renderCertificatePdf,
  ) {}

  /** Issue a certification for a student who completed a course. */
  async issueCertification(
    input: IssueAcademyCertificationRequest,
  ): Promise<IssueCertificationOutcome> {
    const course = (await this.prisma.academyCourse.findFirst({
      where: { id: input.courseId, deletedAt: null },
      select: { id: true, title: true, track: true },
    })) as { id: string; title: string; track: AcademyCourseTrack } | null;
    if (course === null) return { ok: false, reason: 'course_not_found' };

    if (input.enrollmentId !== undefined) {
      const enrollment = (await this.prisma.academyEnrollment.findFirst({
        where: { id: input.enrollmentId, deletedAt: null },
        select: { id: true, studentUserId: true, courseId: true, status: true },
      })) as { id: string; studentUserId: string; courseId: string; status: string } | null;
      if (
        enrollment === null ||
        enrollment.studentUserId !== input.studentUserId ||
        enrollment.courseId !== input.courseId
      ) {
        return { ok: false, reason: 'enrollment_not_found' };
      }
      if (enrollment.status !== 'completed') {
        return { ok: false, reason: 'enrollment_not_completed' };
      }
    }

    // Business-level dedup: one ACTIVE certification per (student, course). A
    // retried issuance returns the existing certificate rather than minting a
    // second one. (Distinct from the @Idempotent() request-replay cache — this
    // also covers two different requests racing the same completion.)
    const existing = (await this.prisma.academyCertification.findFirst({
      where: { studentUserId: input.studentUserId, courseId: input.courseId, status: 'active' },
      select: CERTIFICATION_SELECT,
    })) as CertificationRow | null;
    if (existing !== null) {
      return { ok: true, created: false, certification: toCertificationRecord(existing) };
    }

    const issuedAt = this.now();
    const months = input.expiresInMonths ?? ACADEMY_CERTIFICATION_EXPIRES_IN_MONTHS_DEFAULT;
    const expiresAt = addUtcMonths(issuedAt, months);
    const verificationToken = this.tokenFactory();

    // Create first so the row id seeds the deterministic PDF key, then render +
    // store, then stamp the key. Three steps; the PDF render is pure and the
    // store is a stub today (TS-255-followup-2), so this stays well under the
    // HTTP budget.
    const created = (await this.prisma.academyCertification.create({
      data: {
        studentUserId: input.studentUserId,
        courseId: input.courseId,
        enrollmentId: input.enrollmentId ?? null,
        title: course.title,
        track: course.track,
        holderName: input.holderName,
        status: 'active',
        verificationToken,
        issuedAt,
        expiresAt,
      },
      select: CERTIFICATION_SELECT,
    })) as CertificationRow;

    const key = this.pdfStore.buildCertificateKey({ certificationId: created.id, now: issuedAt });
    const verificationUrl = this.buildVerificationUrl(verificationToken);
    const bytes = await this.renderPdf({
      holderName: input.holderName,
      courseTitle: course.title,
      track: course.track,
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      verificationToken,
      verificationUrl,
    });
    await this.pdfStore.store({ key, bytes });

    const finalized = (await this.prisma.academyCertification.update({
      where: { id: created.id },
      data: { certificatePdfKey: key },
      select: CERTIFICATION_SELECT,
    })) as CertificationRow;

    this.logger.log(
      {
        certificationId: finalized.id,
        studentUserId: finalized.studentUserId,
        courseId: finalized.courseId,
        track: finalized.track,
      },
      'academy certification issued',
    );
    return { ok: true, created: true, certification: toCertificationRecord(finalized) };
  }

  /** Admin: list certifications matching the filter, newest issued first. */
  async listCertifications(
    filter: ListAcademyCertificationsQuery,
  ): Promise<readonly AcademyCertificationRecord[]> {
    const where: {
      studentUserId?: string;
      courseId?: string;
      status?: AcademyCertificationStatus;
    } = {};
    if (filter.studentUserId !== undefined) where.studentUserId = filter.studentUserId;
    if (filter.courseId !== undefined) where.courseId = filter.courseId;
    if (filter.status !== undefined) where.status = filter.status;

    const rows = (await this.prisma.academyCertification.findMany({
      where,
      orderBy: [{ issuedAt: 'desc' }, { id: 'desc' }],
      take: filter.limit,
      select: CERTIFICATION_SELECT,
    })) as CertificationRow[];
    return rows.map(toCertificationRecord);
  }

  /** Admin: read a single certification by id (full record). */
  async getCertification(id: string): Promise<AcademyCertificationRecord | null> {
    const row = (await this.prisma.academyCertification.findFirst({
      where: { id },
      select: CERTIFICATION_SELECT,
    })) as CertificationRow | null;
    return row === null ? null : toCertificationRecord(row);
  }

  /** Admin: revoke a certification (append-only — status flip, never delete). */
  async revokeCertification(id: string, reason?: string): Promise<RevokeCertificationOutcome> {
    const row = (await this.prisma.academyCertification.findFirst({
      where: { id },
      select: { id: true, status: true },
    })) as { id: string; status: AcademyCertificationStatus } | null;
    if (row === null) return { ok: false, reason: 'not_found' };
    if (row.status === 'revoked') return { ok: false, reason: 'already_revoked' };

    const updated = (await this.prisma.academyCertification.update({
      where: { id },
      data: { status: 'revoked', revokedAt: this.now() },
      select: CERTIFICATION_SELECT,
    })) as CertificationRow;

    this.logger.log(
      { certificationId: id, studentUserId: updated.studentUserId, reason: reason ?? null },
      'academy certification revoked',
    );
    return { ok: true, certification: toCertificationRecord(updated) };
  }

  /**
   * Public verification by token (the `/verify/cert/{token}` page). Returns the
   * PII-minimised subset, or null when the token resolves to nothing. The
   * controller wraps this in `runWithoutTenantContext` (the read touches the
   * scoped `AcademyCertification` model with no authenticated frame).
   */
  async getVerificationByToken(token: string): Promise<PublicCertificationVerification | null> {
    const row = (await this.prisma.academyCertification.findFirst({
      where: { verificationToken: token },
      select: {
        title: true,
        track: true,
        holderName: true,
        status: true,
        issuedAt: true,
        expiresAt: true,
      },
    })) as {
      title: string;
      track: AcademyCourseTrack;
      holderName: string | null;
      status: AcademyCertificationStatus;
      issuedAt: Date;
      expiresAt: Date | null;
    } | null;
    if (row === null) return null;

    const notExpired = row.expiresAt === null || row.expiresAt.getTime() > this.now().getTime();
    return {
      holderName: row.holderName,
      courseTitle: row.title,
      track: row.track,
      status: row.status,
      valid: row.status === 'active' && notExpired,
      issuedAt: row.issuedAt.toISOString(),
      expiresAt: row.expiresAt === null ? null : row.expiresAt.toISOString(),
    };
  }

  private buildVerificationUrl(token: string): string {
    return `${this.env.ACADEMY_PUBLIC_BASE_URL}/verify/cert/${token}`;
  }
}

/**
 * Add `months` calendar months to a UTC date. Pure + exported for unit test.
 * `Date.setUTCMonth` rolls overflow forward (e.g. Jan 31 + 1mo → Mar 3), which
 * is acceptable for a multi-month certification expiry.
 */
export function addUtcMonths(from: Date, months: number): Date {
  const result = new Date(from.getTime());
  result.setUTCMonth(result.getUTCMonth() + months);
  return result;
}

/** Project a certification row into the wire `AcademyCertificationRecord`. */
export function toCertificationRecord(row: CertificationRow): AcademyCertificationRecord {
  return {
    id: row.id,
    studentUserId: row.studentUserId,
    courseId: row.courseId,
    enrollmentId: row.enrollmentId,
    title: row.title,
    track: row.track,
    holderName: row.holderName,
    status: row.status,
    verificationToken: row.verificationToken,
    certificatePdfKey: row.certificatePdfKey,
    issuedAt: row.issuedAt.toISOString(),
    expiresAt: row.expiresAt === null ? null : row.expiresAt.toISOString(),
    revokedAt: row.revokedAt === null ? null : row.revokedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
