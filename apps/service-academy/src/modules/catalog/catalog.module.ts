import { Module } from '@nestjs/common';

import { CohortsController } from './controllers/cohorts.controller';
import { CoursesController } from './controllers/courses.controller';
import { LessonsController } from './controllers/lessons.controller';
import { ModulesController } from './controllers/modules.controller';
import { CohortsService } from './services/cohorts.service';
import { CoursesService } from './services/courses.service';
import { LessonsService } from './services/lessons.service';
import { ModulesService } from './services/modules.service';

/**
 * Catalog bounded module (TS-251; PRD §9.1, §9.5; PDD §15.1) — the Cooking
 * Academy course-catalog admin surface. The first authenticated HTTP surface
 * on service-academy.
 *
 * Composition (four sibling resources of the course → module → lesson tree
 * plus cohorts):
 *   - `CoursesController` / `CoursesService` — create / list / detail-tree /
 *     edit / archive (status) / soft-delete a course.
 *   - `ModulesController` / `ModulesService` — manage the ordered modules
 *     within a course (create / list / edit / delete-with-lesson-cascade).
 *   - `LessonsController` / `LessonsService` — manage the ordered lessons
 *     within a module (create / list / edit / delete).
 *   - `CohortsController` / `CohortsService` — manage a course's cohort runs
 *     (create / list / edit / soft-delete) with a status-transition matrix.
 *
 * Every endpoint is gated on `academy:read` (reads) / `academy:write`
 * (mutations) via `@RequirePermissions(...)` + `PermissionGuard`; the
 * mutations honour `Idempotency-Key` via `@Idempotent()`. The catalog tables
 * are platform-wide (no tenant axis) so the TS-141 gate is not consulted
 * (they sit in service-academy's `unscopedModels`).
 */
@Module({
  controllers: [CoursesController, ModulesController, LessonsController, CohortsController],
  providers: [CoursesService, ModulesService, LessonsService, CohortsService],
  exports: [CoursesService, ModulesService, LessonsService, CohortsService],
})
export class CatalogModule {}
