import {
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Query,
} from '@nestjs/common';
import {
  ListPublicBlogArticlesQuerySchema,
  PublicBlogArticleResponseSchema,
  PublicBlogArticlesListResponseSchema,
  type ListPublicBlogArticlesQuery,
  type PublicBlogArticleResponse,
  type PublicBlogArticlesListResponse,
} from '@taste-and-see/contracts';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import {
  TENANT_CONTEXT_STORE_TOKEN,
  runWithoutTenantContext,
  type TenantContextStore,
} from '@taste-and-see/nest-prisma-tenant-scope';

import { PublicBlogMetrics } from '../public-blog-metrics';
import { PublicBlogService } from '../services/public-blog.service';

/**
 * PUBLIC blog read HTTP boundary (TS-282-followup-3; PRD §10.10; PDD §19.1) —
 * service-content's FIRST anonymous entrypoint.
 *
 *   GET /api/v1/content/blog/articles        — published index (page + category filter). No auth.
 *   GET /api/v1/content/blog/articles/:slug  — one published article.             No auth.
 *
 * **No authentication** — this is the marketing-site blog anyone can read.
 * Rate limiting and edge caching happen at the gateway proxy; the responses
 * here still carry `Cache-Control` so any intermediary can cache.
 *
 * **Published-only, no draft oracle.** The repository's `where` clauses carry
 * `status: 'published'`, and the service folds a missing head version into the
 * same outcome — a draft slug, an archived slug, and a never-existed slug are
 * one uniform 404.
 *
 * **Tenant-scoping.** There is no authenticated `RequestContext` here, so the
 * reads would hit the TS-141 gate's `block` outcome. Each handler wraps its
 * body in `runWithoutTenantContext(this.tenantStore, 'content-public-blog-read',
 * ...)` — the unique, grep-able exempt reason the `app.module.ts` doc-block
 * mandates for the first non-`AccessTokenGuard` entrypoint (mirrors the
 * academy `CertificationVerifyController` posture).
 *
 * Response bodies are parse-checked against the public contracts before they
 * leave the service — the projection is a strict subset of the admin shapes,
 * and the gateway parse-checks again at the edge (defence-in-depth).
 */
@Controller()
export class PublicBlogController {
  constructor(
    private readonly blog: PublicBlogService,
    private readonly metrics: PublicBlogMetrics,
    @Inject(TENANT_CONTEXT_STORE_TOKEN) private readonly tenantStore: TenantContextStore,
  ) {}

  @Get('api/v1/content/blog/articles')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=600')
  async list(
    @Query(new ZodValidationPipe(ListPublicBlogArticlesQuerySchema))
    query: ListPublicBlogArticlesQuery,
  ): Promise<PublicBlogArticlesListResponse> {
    return runWithoutTenantContext(this.tenantStore, 'content-public-blog-read', async () => {
      const result = await this.blog.listArticles({
        page: query.page,
        categorySlug: query.category,
      });
      this.metrics.recordRead('list', 'ok');
      return PublicBlogArticlesListResponseSchema.parse(result);
    });
  }

  @Get('api/v1/content/blog/articles/:slug')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=600')
  async detail(@Param('slug') slug: string): Promise<PublicBlogArticleResponse> {
    return runWithoutTenantContext(this.tenantStore, 'content-public-blog-read', async () => {
      const outcome = await this.blog.getArticleBySlug(slug);
      if (!outcome.ok) {
        this.metrics.recordRead('detail', 'not_found');
        throw publishedArticleNotFound(slug);
      }
      this.metrics.recordRead('detail', 'ok');
      return PublicBlogArticleResponseSchema.parse({ article: outcome.article });
    });
  }
}

/** Uniform 404 — identical for draft, archived, and never-existed slugs. */
function publishedArticleNotFound(slug: string): NotFoundException {
  return new NotFoundException({
    type: 'about:blank',
    title: 'Not Found',
    status: HttpStatus.NOT_FOUND,
    detail: `No published article found for slug '${slug}'.`,
  });
}
