import { BadRequestException, type PipeTransform } from '@nestjs/common';
import type { ZodIssue, ZodTypeAny } from 'zod';

/**
 * Generic validation pipe driven by a Zod schema (CLAUDE.md §3.3).
 *
 * Calling `new ZodValidationPipe(SomeSchema)` produces an
 * argument-decorator-compatible pipe that:
 *
 *   1. Runs `schema.safeParse(value)` at the controller boundary.
 *   2. On success, returns the parsed (and thereby trusted) value.
 *   3. On failure, throws a `BadRequestException` whose response body
 *      carries an RFC 7807 Problem Details payload (`type`, `title`,
 *      `status`, `detail`, `errors[]`). The global `RfcProblemFilter`
 *      attaches the `traceId` + `instance` fields so the client can
 *      correlate with logs.
 *
 * Schemas are constructed with `.strict()` at the contracts layer so
 * unknown fields are rejected at parse time — extra typo'd fields
 * never silently round-trip.
 */
export class ZodValidationPipe<TSchema extends ZodTypeAny> implements PipeTransform {
  constructor(private readonly schema: TSchema) {}

  transform(value: unknown): unknown {
    const result = this.schema.safeParse(value);
    if (result.success) {
      return result.data;
    }

    throw new BadRequestException({
      type: 'about:blank',
      title: 'Bad Request',
      status: 400,
      detail: 'Request payload failed validation.',
      errors: formatIssues(result.error.issues),
    });
  }
}

interface FormattedIssue {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

function formatIssues(issues: readonly ZodIssue[]): readonly FormattedIssue[] {
  return issues.map((issue) => ({
    path: issue.path.length === 0 ? '(root)' : issue.path.join('.'),
    code: issue.code,
    message: issue.message,
  }));
}
