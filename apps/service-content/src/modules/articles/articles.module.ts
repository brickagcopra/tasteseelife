import { Module } from '@nestjs/common';

import { ContentEmittersModule } from '../audit/content-emitters.module';

import { ArticlesController } from './controllers/articles.controller';
import { ArticleRepository } from './repositories/article.repository';
import { ArticlesService } from './services/articles.service';

/**
 * Blog / help-article CMS bounded module (TS-284-followup-3; PRD §10.10,
 * §10.11; PDD §19) — the content-admin article-authoring surface. Mirrors
 * `PagesModule` on the same auth / idempotency / outbox wiring (registered
 * globally in `app.module.ts`).
 *
 * Composition:
 *   - `ArticlesController` — list / create / detail / update; append a version;
 *     read a single version; publish a version live.
 *   - `ArticlesService` — the domain decisions (slug uniqueness, category
 *     validation, monotonic version numbering, the publish lifecycle) + atomic
 *     audit emission.
 *   - `ArticleRepository` — persistence over the `articles` / `article_versions`
 *     tables (+ a `help_categories` existence check for category assignment).
 *
 * Reads gated on `content:read`, authoring on `content:edit`, the publish lever
 * on `content:publish`. `ArticlesService` is exported so future surfaces (the
 * public blog read API, TS-286 help search) can compose it.
 */
@Module({
  // TS-506 — `ArticlesService` injects `ContentNewsletterEmitter` +
  // `ContentSearchEmitter`, neither of which any module declared.
  imports: [ContentEmittersModule],
  controllers: [ArticlesController],
  providers: [ArticlesService, ArticleRepository],
  exports: [ArticlesService],
})
export class ArticlesModule {}
