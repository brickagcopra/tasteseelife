import {
  CONTENT_PAGE_MATERIAL_CHANGED,
  ContentPageMaterialChangedSchema,
} from '@taste-and-see/contracts';
import { OutboxService, type AppendResult } from '@taste-and-see/nest-outbox';
import { describe, expect, it, vi } from 'vitest';

import {
  ContentLegalEmitter,
  MaterialChangeEmitFailedError,
  type MaterialChangeDescriptor,
} from './content-legal-emitter';

const TX = {} as never;

function descriptor(overrides: Partial<MaterialChangeDescriptor> = {}): MaterialChangeDescriptor {
  return {
    pageId: 'page_1',
    pageVersionId: 'ver_3',
    slug: 'privacy',
    versionNo: 3,
    effectiveAt: '2026-07-01T00:00:00.000Z',
    materialChangeNote: 'New data-retention window.',
    ...overrides,
  };
}

function build(result: AppendResult): {
  emitter: ContentLegalEmitter;
  append: ReturnType<typeof vi.fn>;
} {
  const append = vi.fn(async (): Promise<AppendResult> => result);
  const outbox = { append } as unknown as OutboxService;
  return { emitter: new ContentLegalEmitter(outbox), append };
}

describe('ContentLegalEmitter.emit', () => {
  const appended: AppendResult = {
    kind: 'appended',
    eventId: 'ignored',
    eventName: CONTENT_PAGE_MATERIAL_CHANGED,
    occurredAt: new Date(),
  };

  it('appends content.page.material_changed mapping the descriptor to a valid payload', async () => {
    const { emitter, append } = build(appended);
    await emitter.emit(TX, descriptor());

    expect(append).toHaveBeenCalledTimes(1);
    const [, args] = append.mock.calls[0]!;
    expect(args.eventName).toBe(CONTENT_PAGE_MATERIAL_CHANGED);
    expect(args.payload).toMatchObject({
      pageId: 'page_1',
      pageVersionId: 'ver_3',
      slug: 'privacy',
      versionNo: 3,
      effectiveAt: '2026-07-01T00:00:00.000Z',
      materialChangeNote: 'New data-retention window.',
    });
    expect(ContentPageMaterialChangedSchema.safeParse(args.payload).success).toBe(true);
  });

  it('stamps the SAME eventId + occurredAt on the row args and the payload envelope', async () => {
    const { emitter, append } = build(appended);
    await emitter.emit(TX, descriptor());
    const [, args] = append.mock.calls[0]!;
    expect(args.eventId).toBe(args.payload.eventId);
    expect((args.occurredAt as Date).toISOString()).toBe(args.payload.occurredAt);
  });

  it('carries a null note through to the payload', async () => {
    const { emitter, append } = build(appended);
    await emitter.emit(TX, descriptor({ materialChangeNote: null }));
    const [, args] = append.mock.calls[0]!;
    expect(args.payload.materialChangeNote).toBeNull();
    expect(ContentPageMaterialChangedSchema.safeParse(args.payload).success).toBe(true);
  });

  it('throws MaterialChangeEmitFailedError when the outbox rejects the payload', async () => {
    const { emitter } = build({
      kind: 'validation_failed',
      eventName: CONTENT_PAGE_MATERIAL_CHANGED,
      issues: [{ path: ['slug'], message: 'bad' }],
    });
    await expect(emitter.emit(TX, descriptor())).rejects.toBeInstanceOf(
      MaterialChangeEmitFailedError,
    );
  });
});
