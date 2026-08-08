import { Module } from '@nestjs/common';

import { AuthorsController } from './controllers/authors.controller';
import { AuthorRepository } from './repositories/author.repository';
import { AuthorsService } from './services/authors.service';

/**
 * Author profiles + multi-author collaboration bounded module (TS-283; PRD
 * §10.10; PDD §19.1). Mirrors `ArticlesModule` on the same auth / idempotency /
 * outbox wiring (registered globally in `app.module.ts`).
 *
 * Composition:
 *   - `AuthorsController` — author-profile CRUD + the article-byline sub-resource
 *     (`GET | PUT /articles/:articleId/authors`).
 *   - `AuthorsService` — `userId`-uniqueness on create, partial-update semantics,
 *     and the replace-set byline assignment (article + author existence gates) +
 *     atomic audit emission.
 *   - `AuthorRepository` — persistence over `content_authors` / `article_authors`.
 *
 * Reads gated on `content:read`, authoring on `content:edit`. `AuthorsService` is
 * exported so a future public byline read surface can compose it.
 */
@Module({
  controllers: [AuthorsController],
  providers: [AuthorsService, AuthorRepository],
  exports: [AuthorsService],
})
export class AuthorsModule {}
