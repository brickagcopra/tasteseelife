import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ZodValidationPipe } from './zod-validation.pipe';

const Schema = z
  .object({
    email: z.string().email(),
    age: z.number().int().nonnegative(),
  })
  .strict();

describe('ZodValidationPipe', () => {
  it('returns parsed data on success', () => {
    const pipe = new ZodValidationPipe(Schema);
    const out = pipe.transform({ email: 'a@b.co', age: 30 });
    expect(out).toEqual({ email: 'a@b.co', age: 30 });
  });

  it('throws BadRequestException with RFC 7807 body on failure', () => {
    const pipe = new ZodValidationPipe(Schema);
    expect.assertions(5);
    try {
      pipe.transform({ email: 'not-an-email', age: -1 });
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      const body = (err as BadRequestException).getResponse() as Record<string, unknown>;
      expect(body['type']).toBe('about:blank');
      expect(body['title']).toBe('Bad Request');
      expect(body['status']).toBe(400);
      expect(Array.isArray(body['errors'])).toBe(true);
    }
  });

  it('rejects unknown fields when the schema is .strict()', () => {
    const pipe = new ZodValidationPipe(Schema);
    expect(() => pipe.transform({ email: 'a@b.co', age: 30, extra: 'nope' })).toThrow(
      BadRequestException,
    );
  });

  it('formats issues with path / code / message', () => {
    const pipe = new ZodValidationPipe(Schema);
    try {
      pipe.transform({ email: 'bad', age: 30 });
    } catch (err) {
      const body = (err as BadRequestException).getResponse() as { readonly errors: unknown[] };
      const first = body.errors[0] as { path: string; code: string; message: string };
      expect(first.path).toBe('email');
      expect(typeof first.code).toBe('string');
      expect(typeof first.message).toBe('string');
    }
  });

  it('uses "(root)" as the path on top-level failures', () => {
    const arraySchema = z.array(z.string());
    const pipe = new ZodValidationPipe(arraySchema);
    try {
      pipe.transform('not-an-array');
    } catch (err) {
      const body = (err as BadRequestException).getResponse() as {
        readonly errors: { path: string }[];
      };
      expect(body.errors[0]?.path).toBe('(root)');
    }
  });
});
