import { Global, Module, type DynamicModule } from '@nestjs/common';

import { AuditEmitter } from '../audit-emitter';
import { AUDIT_PRODUCER_SERVICE } from './tokens';

export interface AuditModuleOptions {
  /**
   * The producing bounded context, e.g. `service-content`. Required rather
   * than defaulted: a wrong-but-plausible producer name in a log line sends
   * whoever is reading it to the wrong service. Same reasoning that made
   * `source` required on `PagerDutyModule` (TS-302b), where a defaulted value
   * had already caused exactly that.
   */
  readonly producerService: string;
}

/**
 * Shared admin-mutation audit emission (TS-303b-followup-1; CLAUDE.md §3.6).
 *
 * `@Global()` so any feature module performing an admin mutation can inject
 * `AuditEmitter` without re-importing — the shape service-ads, service-content
 * and service-trust-safety had each arrived at independently.
 *
 * `OutboxService` is NOT provided here: it comes from the consuming service's
 * own `OutboxModule`, because the outbox is per-service (each writes to its
 * own schema's `outbox_events`). This module supplies only the emitter and its
 * producer name.
 */
@Global()
@Module({})
export class AuditModule {
  static forRoot(options: AuditModuleOptions): DynamicModule {
    const producerService = options.producerService.trim();
    if (producerService.length === 0) {
      // Eager, at module-definition time: a blank producer name should fail
      // the BOOT, not show up as an empty field in a log line months later.
      throw new Error('AuditModule.forRoot: producerService must be a non-empty string');
    }

    return {
      module: AuditModule,
      providers: [{ provide: AUDIT_PRODUCER_SERVICE, useValue: producerService }, AuditEmitter],
      exports: [AuditEmitter],
    };
  }
}
