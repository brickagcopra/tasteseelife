import { Module } from '@nestjs/common';

import { PublicBlogController } from './controllers/public-blog.controller';
import { PublicBlogMetrics } from './public-blog-metrics';
import { PublicBlogRepository } from './repositories/public-blog.repository';
import { PublicBlogService } from './services/public-blog.service';

/**
 * PUBLIC blog read module (TS-282-followup-3; PRD §10.10; PDD §19.1) —
 * service-content's first anonymous surface: the published-articles projection
 * behind the web-marketing `/blog` pages (via the gateway's unauthenticated
 * proxy).
 *
 * Composition:
 *   - `PublicBlogController` — the two anonymous reads (index + by-slug),
 *     each wrapped in the `content-public-blog-read` tenant-exempt frame.
 *   - `PublicBlogService` — the published-only projection: head-version merge
 *     + `publishedAt` ordering, category filter/pagination, byline + SEO +
 *     comments assembly. Draft/archived/missing collapse to one `not_found`.
 *   - `PublicBlogRepository` — explicit-column reads that ALWAYS carry
 *     `status: 'published'` in their `where` clauses.
 *   - `PublicBlogMetrics` — `content_public_blog_reads_total{surface,outcome}`.
 *
 * Deliberately does NOT import the authoring modules — the public read path is
 * self-contained so its projections can never accidentally widen to an admin
 * shape (the one shared piece, the `toSeoRecord` mapper, is a pure function).
 */
@Module({
  controllers: [PublicBlogController],
  providers: [PublicBlogService, PublicBlogRepository, PublicBlogMetrics],
})
export class PublicBlogModule {}
