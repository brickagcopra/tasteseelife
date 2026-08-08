import {
  BadRequestException,
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
  Req,
  UnauthorizedException,
  UnprocessableEntityException,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import {
  type ActivateTemplateVersionRequest,
  ActivateTemplateVersionRequestSchema,
  type CreateTemplateRequest,
  CreateTemplateRequestSchema,
  type CreateTemplateVersionRequest,
  CreateTemplateVersionRequestSchema,
  type ListTemplatesQuery,
  ListTemplatesQuerySchema,
  type TemplateResponse,
  type TemplatesListResponse,
  TemplatesListResponseSchema,
  type TemplateVersionResponse,
  type TemplateVersionsListResponse,
  TemplateVersionsListResponseSchema,
} from '@taste-and-see/contracts';
import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';

import { toTemplateDto, toVersionDto } from '../mappers/template.mapper';
import { type TemplatesServiceFailure, TemplatesService } from '../services/templates.service';

/**
 * Notification template admin HTTP boundary (TS-072).
 *
 * Six endpoints under `/api/v1/admin/notification/templates`:
 *
 *   POST   /                                  — create template
 *   GET    /                                  — list templates
 *   GET    /:id                               — template detail
 *   POST   /:id/versions                      — create new version
 *   GET    /:id/versions                      — list versions
 *   POST   /:id/versions/:version/activate    — flip active pointer
 *
 * Authentication. Every endpoint is behind `AccessTokenGuard` —
 * the access token is minted by `service-identity`. Permission
 * gating (`notification:write`) lands with TS-052-followup-11's
 * `PermissionGuard` lift (captured as TS-072-followup-7).
 *
 * Authorisation. Today every authenticated user can author templates.
 * Per-tenant template overrides (PDD §400) land with the partner
 * brand kit — captured as TS-072-followup-X candidate when the
 * partner-org schema arrives.
 */
@Controller()
@UseGuards(AccessTokenGuard)
export class TemplatesController {
  constructor(private readonly templates: TemplatesService) {}

  /**
   * POST /api/v1/admin/notification/templates
   *
   * Creates a template registry row. The `(code, locale)` pair is
   * UNIQUE; a re-submission returns 409 Conflict.
   *
   * Status codes:
   *   201 Created       — body is the new template (no active version).
   *   400 Bad Request   — Zod validation failed.
   *   401 Unauthorized  — missing / invalid access token.
   *   409 Conflict      — `(code, locale)` already exists.
   */
  @Post('api/v1/admin/notification/templates')
  @HttpCode(HttpStatus.CREATED)
  @UsePipes(new ZodValidationPipe(CreateTemplateRequestSchema))
  async createTemplate(
    @Body() body: CreateTemplateRequest,
    @Req() request: RequestWithContext,
  ): Promise<TemplateResponse> {
    const actorUserId = requireActorUserId(request);
    const result = await this.templates.createTemplate({
      code: body.code,
      locale: body.locale,
      kind: body.kind,
      name: body.name,
      description: body.description,
      createdByUserId: actorUserId,
    });
    if (result.outcome === 'failed') {
      throwFailure(result.failure);
    }
    return toTemplateDto(result.template);
  }

  /**
   * GET /api/v1/admin/notification/templates
   *
   * Cursor-paginated. Optional `kind`, `locale`, `code` filters.
   *
   * Status codes:
   *   200 OK            — body is the TemplatesListResponse.
   *   400 Bad Request   — query string failed Zod validation.
   *   401 Unauthorized  — missing / invalid access token.
   */
  @Get('api/v1/admin/notification/templates')
  @HttpCode(HttpStatus.OK)
  async listTemplates(
    @Query(new ZodValidationPipe(ListTemplatesQuerySchema))
    query: ListTemplatesQuery,
  ): Promise<TemplatesListResponse> {
    const result = await this.templates.listTemplates({
      kind: query.kind,
      locale: query.locale,
      code: query.code,
      cursor: query.cursor,
      limit: query.limit,
    });
    if (result.outcome === 'failed') {
      throwFailure(result.failure);
    }
    return TemplatesListResponseSchema.parse({
      templates: result.templates.map(toTemplateDto),
      nextCursor: result.nextCursor,
    });
  }

  /**
   * GET /api/v1/admin/notification/templates/:id
   *
   * Status codes:
   *   200 OK            — body is the TemplateResponse.
   *   401 Unauthorized  — missing / invalid access token.
   *   404 Not Found     — no such template.
   */
  @Get('api/v1/admin/notification/templates/:id')
  @HttpCode(HttpStatus.OK)
  async getTemplate(@Param('id') id: string): Promise<TemplateResponse> {
    const result = await this.templates.getTemplateById(id);
    if (result.outcome === 'failed') {
      throwFailure(result.failure);
    }
    return toTemplateDto(result.template);
  }

  /**
   * POST /api/v1/admin/notification/templates/:id/versions
   *
   * Adds a new version (monotonic). MJML compiles to HTML at write
   * time so the render path stays sync. Set `activate: true` to flip
   * the active pointer in the same transaction.
   *
   * Status codes:
   *   201 Created       — body is the new TemplateVersionResponse.
   *   400 Bad Request   — Zod validation failed.
   *   401 Unauthorized  — missing / invalid access token.
   *   404 Not Found     — no such template.
   *   409 Conflict      — concurrent writer landed the same version
   *                       number first; the caller may retry.
   *   422 Unprocessable — MJML compile failed / body-shape violates
   *                       per-kind rules / variables schema invalid.
   */
  @Post('api/v1/admin/notification/templates/:id/versions')
  @HttpCode(HttpStatus.CREATED)
  async createVersion(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(CreateTemplateVersionRequestSchema))
    body: CreateTemplateVersionRequest,
    @Req() request: RequestWithContext,
  ): Promise<TemplateVersionResponse> {
    const actorUserId = requireActorUserId(request);
    const result = await this.templates.createVersion({
      templateId: id,
      subject: body.subject,
      bodyMjml: body.bodyMjml,
      bodyHtml: body.bodyHtml,
      bodyText: body.bodyText,
      variablesSchema: body.variablesSchema,
      activate: body.activate,
      changeSummary: body.changeSummary,
      createdByUserId: actorUserId,
    });
    if (result.outcome === 'failed') {
      throwFailure(result.failure);
    }
    return toVersionDto(result.version);
  }

  /**
   * GET /api/v1/admin/notification/templates/:id/versions
   *
   * Versions newest-first. `isActive` is true exactly for the active
   * version (or false for everything if no version is active).
   *
   * Status codes:
   *   200 OK            — body is the TemplateVersionsListResponse.
   *   401 Unauthorized  — missing / invalid access token.
   *   404 Not Found     — no such template.
   */
  @Get('api/v1/admin/notification/templates/:id/versions')
  @HttpCode(HttpStatus.OK)
  async listVersions(@Param('id') id: string): Promise<TemplateVersionsListResponse> {
    const result = await this.templates.listVersions(id);
    if (result.outcome === 'failed') {
      throwFailure(result.failure);
    }
    return TemplateVersionsListResponseSchema.parse({
      versions: result.versions.map(toVersionDto),
    });
  }

  /**
   * POST /api/v1/admin/notification/templates/:id/versions/:version/activate
   *
   * Flips the active-version pointer. Idempotent — re-activating the
   * already-active version is a no-op + audit log entry.
   *
   * Status codes:
   *   200 OK            — body is the now-active TemplateVersionResponse.
   *   400 Bad Request   — `:version` not a positive integer.
   *   401 Unauthorized  — missing / invalid access token.
   *   404 Not Found     — no such version (template or version id).
   */
  @Post('api/v1/admin/notification/templates/:id/versions/:version/activate')
  @HttpCode(HttpStatus.OK)
  async activateVersion(
    @Param('id') id: string,
    @Param('version') versionParam: string,
    @Body(new ZodValidationPipe(ActivateTemplateVersionRequestSchema))
    _body: ActivateTemplateVersionRequest,
    @Req() request: RequestWithContext,
  ): Promise<TemplateVersionResponse> {
    const actorUserId = requireActorUserId(request);
    const version = parsePositiveInt(versionParam, 'version');
    const result = await this.templates.activateVersion({
      templateId: id,
      version,
      actorUserId,
    });
    if (result.outcome === 'failed') {
      throwFailure(result.failure);
    }
    return toVersionDto(result.version);
  }
}

// ─── Failure → HTTP mapping ─────────────────────────────────────────────

/**
 * Maps service-layer failure variants to RFC 7807 error responses.
 * `throw` rather than `return` so the controller signature stays
 * `Promise<TemplateResponse>` without the `failed` arm.
 */
function throwFailure(failure: TemplatesServiceFailure): never {
  switch (failure.kind) {
    case 'code_locale_conflict':
      throw new ConflictException({
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        detail: `A template with code '${failure.code}' and locale '${failure.locale}' already exists.`,
      });
    case 'template_not_found':
    case 'version_not_found':
    case 'template_or_active_version_not_found':
      throw new NotFoundException({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: notFoundDetail(failure.kind),
      });
    case 'version_conflict':
      throw new ConflictException({
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        detail: 'A concurrent writer landed the same version number first; please retry.',
      });
    case 'invalid_body_shape':
    case 'invalid_variables_schema':
      throw new UnprocessableEntityException({
        type: 'about:blank',
        title: 'Unprocessable Entity',
        status: 422,
        detail: failure.message,
      });
    case 'mjml_compilation_failed':
      throw new UnprocessableEntityException({
        type: 'about:blank',
        title: 'Unprocessable Entity',
        status: 422,
        detail: 'MJML compilation failed.',
        errors: failure.errors,
      });
    case 'variable_validation_failed':
      throw new UnprocessableEntityException({
        type: 'about:blank',
        title: 'Unprocessable Entity',
        status: 422,
        detail: 'Variable validation failed.',
        errors: failure.issues,
      });
    case 'handlebars_render_failed':
      throw new UnprocessableEntityException({
        type: 'about:blank',
        title: 'Unprocessable Entity',
        status: 422,
        detail: failure.message,
      });
  }
}

function notFoundDetail(
  kind: 'template_not_found' | 'version_not_found' | 'template_or_active_version_not_found',
): string {
  switch (kind) {
    case 'template_not_found':
      return 'No notification template with that id.';
    case 'version_not_found':
      return 'No notification template version with that template id and version number.';
    case 'template_or_active_version_not_found':
      return 'No notification template with that code + locale, or the template has no active version.';
  }
}

function parsePositiveInt(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    throw new BadRequestException({
      type: 'about:blank',
      title: 'Bad Request',
      status: 400,
      detail: `'${field}' must be a positive integer.`,
    });
  }
  return parsed;
}

function requireActorUserId(request: RequestWithContext): string {
  const userId = request.requestContext?.userId;
  if (typeof userId !== 'string' || userId.length === 0) {
    // AccessTokenGuard would normally reject before reaching here;
    // defence-in-depth against a future regression that lifts the
    // guard from a route.
    throw new UnauthorizedException({
      type: 'about:blank',
      title: 'Unauthorized',
      status: 401,
      detail: 'Authentication required.',
    });
  }
  return userId;
}
