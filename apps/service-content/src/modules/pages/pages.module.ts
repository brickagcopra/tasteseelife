import { Module } from '@nestjs/common';

import { ContentEmittersModule } from '../audit/content-emitters.module';

import { PagesController } from './controllers/pages.controller';
import { PageRepository } from './repositories/page.repository';
import { PagesService } from './services/pages.service';

/**
 * Static-pages CMS bounded module (TS-284; PRD §10.11; PDD §19.2) — the
 * content-admin page-authoring surface. The first authenticated HTTP surface on
 * service-content.
 *
 * Composition:
 *   - `PagesController` — list / create / detail; append a version; read a
 *     single version; publish a version live.
 *   - `PagesService` — the domain decisions (slug uniqueness, monotonic version
 *     numbering, the publish lifecycle) + atomic audit emission.
 *   - `PageRepository` — persistence over the two `content`-schema tables.
 *
 * Reads are gated on `content:read`, authoring on `content:edit`, the publish
 * lever on `content:publish` (`@RequirePermissions(...)` + `PermissionGuard`);
 * mutations honour `Idempotency-Key` via `@Idempotent()`. The two tables are
 * platform-wide content-staff inventory (no tenant axis) so the TS-141 gate
 * short-circuits (they sit in service-content's `unscopedModels`).
 *
 * `PagesService` is exported so the (future) public legal-page read surface
 * (TS-284-followup-1) and the blog/help authoring surfaces (TS-281+) can compose it.
 */
@Module({
  // TS-506 — `PagesService` injects `ContentLegalEmitter`, which no module
  // declared; the service could not be constructed and the process died in
  // the injector.
  imports: [ContentEmittersModule],
  controllers: [PagesController],
  providers: [PagesService, PageRepository],
  exports: [PagesService],
})
export class PagesModule {}
