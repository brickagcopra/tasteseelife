import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import {
  CONTENT_PAGE_MATERIAL_CHANGED,
  type ContentPageMaterialChanged,
} from '@taste-and-see/contracts';
import { OutboxService, type OutboxRawExecutor } from '@taste-and-see/nest-outbox';

/**
 * What a material page publish carries onto the bus — the page + version
 * identity, the slug, the effective date, and the editor's change note. No PII
 * (this is a content event; the per-subscriber fan-out is the consumer's job).
 */
export interface MaterialChangeDescriptor {
  readonly pageId: string;
  readonly pageVersionId: string;
  readonly slug: string;
  readonly versionNo: number;
  /** ISO-8601 with offset — when the version becomes legally effective. */
  readonly effectiveAt: string;
  readonly materialChangeNote: string | null;
}

/**
 * Raised when the outbox append rejects the `content.page.material_changed`
 * payload (a producer-side validation failure). Thrown INSIDE the publish
 * transaction so the whole publish rolls back — a material change that cannot
 * durably queue its subscriber notification must not go live (the outbox
 * invariant, CLAUDE.md §5.3). In practice unreachable: the payload is built
 * from typed inputs validated against the same registry schema, so this guards
 * a future schema/skew drift rather than a runtime user path.
 */
export class MaterialChangeEmitFailedError extends Error {
  constructor(
    readonly pageVersionId: string,
    readonly issues: ReadonlyArray<{
      readonly path: ReadonlyArray<string | number>;
      readonly message: string;
    }>,
  ) {
    super(`content.page.material_changed payload validation failed for version '${pageVersionId}'`);
    this.name = 'MaterialChangeEmitFailedError';
  }
}

/**
 * Emits `content.page.material_changed` to the transactional outbox (TS-285;
 * PDD §19.2; CLAUDE.md §5.3).
 *
 * Call `emit(tx, descriptor)` from INSIDE the publish `$transaction(async (tx)
 * => …)` so the notification signal commits atomically with the version going
 * live. The relay (`worker-outbox-relay`) already drains `content.outbox_events`
 * (TS-284) — no relay-config change is needed for a new event NAME on the same
 * table. The consumer (`service-notification`, TS-285-followup-1) is idempotent
 * on `eventId`. Sibling to `AuditEmitter` (the same in-tx append shape);
 * ONLY a material publish emits this — an ordinary publish emits just the audit
 * trail.
 */
@Injectable()
export class ContentLegalEmitter {
  private readonly logger = new Logger(ContentLegalEmitter.name);

  constructor(private readonly outbox: OutboxService) {}

  async emit(tx: OutboxRawExecutor, descriptor: MaterialChangeDescriptor): Promise<void> {
    const eventId = randomUUID();
    const occurredAt = new Date();
    const payload: ContentPageMaterialChanged = {
      eventId,
      occurredAt: occurredAt.toISOString(),
      pageId: descriptor.pageId,
      pageVersionId: descriptor.pageVersionId,
      slug: descriptor.slug,
      versionNo: descriptor.versionNo,
      effectiveAt: descriptor.effectiveAt,
      materialChangeNote: descriptor.materialChangeNote,
    };

    const result = await this.outbox.append(tx, {
      eventName: CONTENT_PAGE_MATERIAL_CHANGED,
      payload,
      eventId,
      occurredAt,
    });
    if (result.kind !== 'appended') {
      throw new MaterialChangeEmitFailedError(descriptor.pageVersionId, result.issues);
    }

    this.logger.log(
      {
        pageId: descriptor.pageId,
        pageVersionId: descriptor.pageVersionId,
        slug: descriptor.slug,
        eventId,
      },
      'content.page.material_changed emitted',
    );
  }
}
