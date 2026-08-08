import { Module } from '@nestjs/common';

import { ContentLegalEmitter } from './content-legal-emitter';
import { ContentNewsletterEmitter } from './content-newsletter-emitter';
import { ContentSearchEmitter } from './content-search-emitter';

/**
 * Provides service-content's three domain event emitters (TS-506).
 *
 * **Why this module exists.** All three are `@Injectable()` classes that
 * `PagesService` / `ArticlesService` take as constructor dependencies —
 * and none of them was declared as a provider anywhere. Nest resolves a
 * class dependency from the consuming module's own providers, its
 * imports' exports, or a global module's exports; these appeared in none
 * of those, so `PagesService` could not be constructed and the process
 * died in the injector before binding a port. Nothing caught it because
 * the unit suites construct the services directly with fake emitters,
 * and no test ever compiled the real `AppModule`.
 *
 * They are grouped rather than added to each feature module's
 * `providers` for one reason worth stating: an emitter registered twice
 * is two instances, and while these three are stateless today, the
 * pattern quietly stops being safe the moment one holds a buffer or a
 * dedup set. One declaration, imported where needed.
 *
 * Each takes only `OutboxService`, which the `@Global()`
 * `OutboxModule.forRoot(...)` in `app.module.ts` exports — so this module
 * imports nothing itself.
 *
 * Note this is distinct from `@taste-and-see/nest-audit`'s `AuditModule`
 * (also `@Global()`), which supplies the shared `AuditEmitter` for
 * `audit.action_recorded`. These three emit *domain* events —
 * `content.page.material_changed`, `content.newsletter.send_requested`,
 * and the article search-index pair — on the same in-transaction outbox
 * seam.
 */
@Module({
  providers: [ContentLegalEmitter, ContentNewsletterEmitter, ContentSearchEmitter],
  exports: [ContentLegalEmitter, ContentNewsletterEmitter, ContentSearchEmitter],
})
export class ContentEmittersModule {}
