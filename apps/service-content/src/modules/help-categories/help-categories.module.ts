import { Module } from '@nestjs/common';

import { HelpCategoriesController } from './controllers/help-categories.controller';
import { HelpCategoryRepository } from './repositories/help-category.repository';
import { HelpCategoriesService } from './services/help-categories.service';

/**
 * Help-center taxonomy CMS bounded module (TS-284-followup-3; PRD §10.11; PDD
 * §19.3) — the content-admin category-tree surface. Shares the global auth /
 * idempotency / outbox wiring from `app.module.ts`.
 *
 * Composition:
 *   - `HelpCategoriesController` — list (flat) / create / detail / update.
 *   - `HelpCategoriesService` — slug uniqueness, parent validation, cycle-safe
 *     re-parenting + atomic audit emission.
 *   - `HelpCategoryRepository` — persistence over `help_categories`.
 *
 * Reads gated on `content:read`, mutations on `content:edit`.
 * `HelpCategoriesService` is exported so TS-286 (help hierarchy + ES search) can
 * compose it.
 */
@Module({
  controllers: [HelpCategoriesController],
  providers: [HelpCategoriesService, HelpCategoryRepository],
  exports: [HelpCategoriesService],
})
export class HelpCategoriesModule {}
