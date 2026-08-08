import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { OutboxService } from '@taste-and-see/nest-outbox';
import { describe, expect, it } from 'vitest';

import { AuditEmitter } from '../audit-emitter';
import { AuditModule } from './audit.module';
import { AUDIT_PRODUCER_SERVICE } from './tokens';

/**
 * `OutboxService` is per-service and comes from the consuming app's own
 * `OutboxModule`; this stands in for it so the module's own wiring can be
 * exercised in isolation.
 */
@Global()
@Module({
  providers: [{ provide: OutboxService, useValue: { append: async () => undefined } }],
  exports: [OutboxService],
})
class StubOutboxModule {}

describe('AuditModule.forRoot', () => {
  it('provides an injectable AuditEmitter carrying the producer name', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [StubOutboxModule, AuditModule.forRoot({ producerService: 'service-content' })],
    }).compile();

    expect(moduleRef.get(AuditEmitter)).toBeInstanceOf(AuditEmitter);
    expect(moduleRef.get(AUDIT_PRODUCER_SERVICE)).toBe('service-content');
  });

  it('trims the producer name', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [StubOutboxModule, AuditModule.forRoot({ producerService: '  service-ads  ' })],
    }).compile();

    expect(moduleRef.get(AUDIT_PRODUCER_SERVICE)).toBe('service-ads');
  });

  it.each([[''], ['   ']])(
    'throws at module-definition time on a blank producer name (%j)',
    (producerService) => {
      // Eager, not lazy: a blank producer should fail the BOOT, not turn up as
      // an empty field in a log line months later.
      expect(() => AuditModule.forRoot({ producerService })).toThrow(
        /producerService must be a non-empty string/,
      );
    },
  );

  it('does NOT provide OutboxService — the outbox is per-service', () => {
    // Each service writes to its own schema's `outbox_events`, so the emitter
    // takes the consuming app's outbox rather than shipping one. Asserted
    // structurally: Nest resolves a missing global provider lazily, so
    // `.compile()` alone would not surface it.
    const dynamic = AuditModule.forRoot({ producerService: 'service-x' });

    expect(dynamic.providers).toBeDefined();
    expect(dynamic.providers).not.toContain(OutboxService);
    expect(dynamic.exports).toEqual([AuditEmitter]);
  });
});
