import { timingSafeEqual } from 'node:crypto';

import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Post,
  Req,
  UnauthorizedException,
  UnprocessableEntityException,
  UsePipes,
} from '@nestjs/common';
import {
  type RenderTemplateRequest,
  RenderTemplateRequestSchema,
  type RenderTemplateResponse,
} from '@taste-and-see/contracts';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import {
  TENANT_CONTEXT_STORE_TOKEN,
  type TenantContextStore,
  runWithoutTenantContext,
} from '@taste-and-see/nest-prisma-tenant-scope';
import type { Request } from 'express';

import { ENV_TOKEN } from '../../../config/config.module';
import type { Env } from '../../../config/env';
import { toRenderDto } from '../mappers/template.mapper';
import { TemplatesService } from '../services/templates.service';

/**
 * Internal render endpoint (TS-072).
 *
 *   POST /api/v1/internal/notification/render
 *
 * Cross-service callers (the channel dispatchers in TS-073, plus any
 * upstream that wants a pre-rendered preview) POST a `(templateCode,
 * locale, variables)` triple and get back the assembled message.
 *
 * Authentication. Shared-secret-pinned via
 * `NOTIFICATION_RENDER_HEADER_NAME` / `NOTIFICATION_RENDER_API_KEY`.
 * Constant-time comparison via `crypto.timingSafeEqual` over
 * equal-length buffers (mirrors service-identity's KYC dispatch
 * pattern). The TS-151 NetworkPolicy will restrict this route to
 * in-cluster callers; the header is the application-layer defence-
 * in-depth alongside the network policy.
 *
 * Failure mapping:
 *   401 Unauthorized   — missing / wrong shared-secret header.
 *   400 Bad Request    — Zod validation failed.
 *   404 Not Found      — template not found OR template has no active
 *                        version.
 *   422 Unprocessable  — variable validation failed (missing required,
 *                        unknown variable, type mismatch) OR Handlebars
 *                        template-execution failure.
 *
 * Tenant-scoping (TS-020-followup-2b-platform-rollout). The handler
 * runs BEFORE any `requestContext` exists — the endpoint is shared-
 * secret-pinned, not bearer-token-authenticated, so the
 * `TenantContextInterceptor` cannot seed a scoped frame. The body is
 * wrapped in `runWithoutTenantContext(..., 'internal-notification-render', ...)`
 * so the Prisma extension's gate sees an explicit `exempt` frame
 * rather than failing with `MissingRequestContextError` under the
 * `enforcement: 'enforce'` posture wired in `AppModule`. The
 * `NotificationTemplate` + `NotificationTemplateVersion` models are
 * also marked unscoped in `TenantContextModule.forRoot`'s
 * `unscopedModels` list (Phase-1 templates are global), so the gate
 * would short-circuit before consulting the frame — the wrap is the
 * belt-and-braces defence in case a future read here touches a scoped
 * model. Mirrors the pattern landed in service-identity (KYC dispatch)
 * + service-accounting (recognizer endpoints) + service-payouts
 * (stripe-event ingest).
 */
@Controller()
export class RenderController {
  private readonly internalApiKey: string;
  private readonly internalHeaderName: string;

  constructor(
    private readonly templates: TemplatesService,
    @Inject(ENV_TOKEN) env: Env,
    @Inject(TENANT_CONTEXT_STORE_TOKEN) private readonly tenantStore: TenantContextStore,
  ) {
    this.internalApiKey = env.NOTIFICATION_RENDER_API_KEY;
    this.internalHeaderName = env.NOTIFICATION_RENDER_HEADER_NAME;
  }

  @Post('api/v1/internal/notification/render')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(RenderTemplateRequestSchema))
  async render(
    @Body() body: RenderTemplateRequest,
    @Req() request: Request,
  ): Promise<RenderTemplateResponse> {
    return runWithoutTenantContext(this.tenantStore, 'internal-notification-render', async () => {
      const presented = request.header(this.internalHeaderName);
      if (!isSharedSecretValid(presented, this.internalApiKey)) {
        throw new UnauthorizedException({
          type: 'about:blank',
          title: 'Unauthorized',
          status: 401,
          detail: 'Internal dispatch authentication failed.',
        });
      }

      const result = await this.templates.render({
        templateCode: body.templateCode,
        locale: body.locale,
        variables: body.variables,
      });

      if (result.outcome === 'failed') {
        switch (result.failure.kind) {
          case 'template_or_active_version_not_found':
            throw new NotFoundException({
              type: 'about:blank',
              title: 'Not Found',
              status: 404,
              detail:
                'No notification template with that code + locale, or the template has no active version.',
            });
          case 'variable_validation_failed':
            throw new UnprocessableEntityException({
              type: 'about:blank',
              title: 'Unprocessable Entity',
              status: 422,
              detail: 'Variable validation failed.',
              errors: result.failure.issues,
            });
          case 'handlebars_render_failed':
            throw new UnprocessableEntityException({
              type: 'about:blank',
              title: 'Unprocessable Entity',
              status: 422,
              detail: result.failure.message,
            });
          // The other failure variants belong to write paths; the
          // render path never produces them. Falling through keeps the
          // switch exhaustive without a runtime branch for impossible
          // states.
          default:
            throw new UnprocessableEntityException({
              type: 'about:blank',
              title: 'Unprocessable Entity',
              status: 422,
              detail: 'Render failed.',
            });
        }
      }

      return toRenderDto(result.rendered);
    });
  }
}

/**
 * Constant-time shared-secret comparison. Mirror of the pattern in
 * service-audit's AuditController and service-identity's KycController.
 */
function isSharedSecretValid(presented: string | undefined, expected: string): boolean {
  if (presented === undefined) return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
