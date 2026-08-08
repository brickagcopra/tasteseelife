import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Query,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import {
  AcademyCertificationResponseSchema,
  AcademyCertificationsListResponseSchema,
  IssueAcademyCertificationRequestSchema,
  ListAcademyCertificationsQuerySchema,
  RevokeAcademyCertificationRequestSchema,
  type AcademyCertificationResponse,
  type AcademyCertificationsListResponse,
  type IssueAcademyCertificationRequest,
  type ListAcademyCertificationsQuery,
  type RevokeAcademyCertificationRequest,
} from '@taste-and-see/contracts';
import { AccessTokenGuard, PermissionGuard, RequirePermissions } from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import { Idempotent } from '@taste-and-see/nest-idempotency';

import { CertificationService } from '../services/certification.service';

/**
 * Academy certification ADMIN HTTP boundary (TS-255; PRD §9.3; PDD §15.2).
 *
 *   POST   /api/v1/admin/academy/certifications                       — issue.   `academy:write`.
 *   GET    /api/v1/admin/academy/certifications                       — list.    `academy:read`.
 *   GET    /api/v1/admin/academy/certifications/:certificationId      — detail.  `academy:read`.
 *   POST   .../:certificationId/revocation                            — revoke.  `academy:write`.
 *
 * **Authorisation.** `AccessTokenGuard` (verify JWT + attach RequestContext)
 * then `PermissionGuard` (read `@RequirePermissions(...)`). `AcademyCertification`
 * is tenant-scoped, but admin staff act cross-student: the seeded RequestContext
 * frame satisfies the TS-141 gate (`proceed_scoped`), and the service applies
 * the query-param filters — there is no per-row tenant ownership to enforce for
 * an admin. (The PUBLIC verification surface lives in a separate controller and
 * uses `runWithoutTenantContext`.)
 *
 * **Idempotency.** The write endpoints wear `@Idempotent()`; the issuance path
 * is additionally deduped at the business level (one ACTIVE certification per
 * student+course).
 */
@Controller()
export class CertificationAdminController {
  constructor(private readonly certifications: CertificationService) {}

  @Post('api/v1/admin/academy/certifications')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('academy:write')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Idempotent()
  async issue(
    @Body(new ZodValidationPipe(IssueAcademyCertificationRequestSchema))
    body: IssueAcademyCertificationRequest,
  ): Promise<AcademyCertificationResponse> {
    const outcome = await this.certifications.issueCertification(body);
    if (!outcome.ok) {
      switch (outcome.reason) {
        case 'course_not_found':
          throw notFound(`No academy course found for id '${body.courseId}'.`);
        case 'enrollment_not_found':
          throw notFound(
            `No completed enrollment found for id '${body.enrollmentId ?? ''}' under this student + course.`,
          );
        case 'enrollment_not_completed':
          throw new UnprocessableEntityException({
            type: 'about:blank',
            title: 'Unprocessable Entity',
            status: HttpStatus.UNPROCESSABLE_ENTITY,
            detail: 'The enrollment is not yet completed; a certification cannot be issued.',
          });
      }
    }
    return AcademyCertificationResponseSchema.parse({ certification: outcome.certification });
  }

  @Get('api/v1/admin/academy/certifications')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('academy:read')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  async list(
    @Query(new ZodValidationPipe(ListAcademyCertificationsQuerySchema))
    query: ListAcademyCertificationsQuery,
  ): Promise<AcademyCertificationsListResponse> {
    const certifications = await this.certifications.listCertifications(query);
    return AcademyCertificationsListResponseSchema.parse({ certifications: [...certifications] });
  }

  @Get('api/v1/admin/academy/certifications/:certificationId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('academy:read')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  async detail(
    @Param('certificationId') certificationId: string,
  ): Promise<AcademyCertificationResponse> {
    const certification = await this.certifications.getCertification(certificationId);
    if (certification === null) throw certificationNotFound(certificationId);
    return AcademyCertificationResponseSchema.parse({ certification });
  }

  @Post('api/v1/admin/academy/certifications/:certificationId/revocation')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('academy:write')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Idempotent()
  async revoke(
    @Param('certificationId') certificationId: string,
    @Body(new ZodValidationPipe(RevokeAcademyCertificationRequestSchema))
    body: RevokeAcademyCertificationRequest,
  ): Promise<AcademyCertificationResponse> {
    const outcome = await this.certifications.revokeCertification(certificationId, body.reason);
    if (!outcome.ok) {
      if (outcome.reason === 'not_found') throw certificationNotFound(certificationId);
      throw new ConflictException({
        type: 'about:blank',
        title: 'Conflict',
        status: HttpStatus.CONFLICT,
        detail: `Certification '${certificationId}' is already revoked.`,
      });
    }
    return AcademyCertificationResponseSchema.parse({ certification: outcome.certification });
  }
}

function notFound(detail: string): NotFoundException {
  return new NotFoundException({
    type: 'about:blank',
    title: 'Not Found',
    status: HttpStatus.NOT_FOUND,
    detail,
  });
}

function certificationNotFound(certificationId: string): NotFoundException {
  return notFound(`No academy certification found for id '${certificationId}'.`);
}
