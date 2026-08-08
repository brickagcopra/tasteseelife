import { describe, expect, it } from 'vitest';

import { IDEMPOTENT_METADATA, Idempotent } from './idempotent.decorator';

describe('@Idempotent', () => {
  it('attaches the IDEMPOTENT_METADATA symbol to a method handler', () => {
    class Sample {
      @Idempotent()
      create(): void {
        /* no-op */
      }
    }
    const handler = Sample.prototype.create as unknown as object;
    const flag = Reflect.getMetadata(IDEMPOTENT_METADATA, handler) as unknown;
    expect(flag).toBe(true);
  });

  it('does NOT attach metadata to a sibling method (decorator is method-scoped)', () => {
    class Sample {
      @Idempotent()
      create(): void {
        /* no-op */
      }
      other(): void {
        /* no-op */
      }
    }
    const handler = Sample.prototype.other as unknown as object;
    const flag = Reflect.getMetadata(IDEMPOTENT_METADATA, handler) as unknown;
    expect(flag).toBeUndefined();
  });

  it('also works as a class decorator (metadata attaches to the class)', () => {
    @Idempotent()
    class Sample {
      create(): void {
        /* no-op */
      }
    }
    const flag = Reflect.getMetadata(IDEMPOTENT_METADATA, Sample) as unknown;
    expect(flag).toBe(true);
  });

  it('exports a stable Symbol.for() identity for the metadata key', () => {
    const fromOtherPlace = Symbol.for('@taste-and-see/nest-idempotency:idempotent');
    expect(IDEMPOTENT_METADATA).toBe(fromOtherPlace);
  });
});
