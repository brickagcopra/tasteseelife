import {
  type TemplateResponse,
  type TemplateVersionResponse,
  type RenderTemplateResponse,
  TemplateResponseSchema,
  TemplateVersionResponseSchema,
  RenderTemplateResponseSchema,
} from '@taste-and-see/contracts';

import type { RenderedTemplate, Template, TemplateVersion } from '../services/templates.service';

/**
 * Domain → wire DTO mappers (CLAUDE.md §3.3: "All outbound responses
 * pass through DTO mappers — never return raw Prisma objects to the
 * client.").
 *
 * Each mapper parses-via-contract before returning so a future drift
 * between the service-layer shape and the wire contract surfaces at
 * the boundary, not at the consumer.
 */

export function toTemplateDto(template: Template): TemplateResponse {
  return TemplateResponseSchema.parse({
    id: template.id,
    code: template.code,
    locale: template.locale,
    kind: template.kind,
    name: template.name,
    description: template.description,
    activeVersionId: template.activeVersionId,
    activeVersionNumber: template.activeVersionNumber,
    latestVersionNumber: template.latestVersionNumber,
    createdByUserId: template.createdByUserId,
    createdAt: template.createdAt.toISOString(),
    updatedAt: template.updatedAt.toISOString(),
  });
}

export function toVersionDto(version: TemplateVersion): TemplateVersionResponse {
  return TemplateVersionResponseSchema.parse({
    id: version.id,
    templateId: version.templateId,
    version: version.version,
    subject: version.subject,
    bodyMjml: version.bodyMjml,
    bodyHtml: version.bodyHtml,
    bodyText: version.bodyText,
    variablesSchema: version.variablesSchema,
    isActive: version.isActive,
    changeSummary: version.changeSummary,
    createdByUserId: version.createdByUserId,
    createdAt: version.createdAt.toISOString(),
  });
}

export function toRenderDto(rendered: RenderedTemplate): RenderTemplateResponse {
  return RenderTemplateResponseSchema.parse({
    templateCode: rendered.templateCode,
    locale: rendered.locale,
    kind: rendered.kind,
    version: rendered.version,
    subject: rendered.subject,
    bodyHtml: rendered.bodyHtml,
    bodyText: rendered.bodyText,
  });
}
