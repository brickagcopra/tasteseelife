import { Injectable } from '@nestjs/common';

import type { NotificationVariableEntry, RenderVariableValue } from '@taste-and-see/contracts';

/**
 * Validates render-time variables against a template version's
 * declared `variables_schema`.
 *
 * Three failure modes (PDD §12.2 "variables strictly typed via shared
 * contract package"):
 *
 *   1. Missing required variable — the schema declares `required: true`
 *      and the caller omitted it. Rendering with the default value
 *      would silently substitute the empty string, which is a footgun
 *      for transactional flows (a missing `firstName` would render
 *      "Hi !"). Mapped to 422 Unprocessable Entity.
 *
 *   2. Unknown variable — the caller supplied a variable name the
 *      schema doesn't declare. A typo (`first_name` vs `firstName`)
 *      would otherwise silently render as the empty string. Mapped
 *      to 400 Bad Request.
 *
 *   3. Type mismatch — the caller supplied a string for a `number` slot
 *      (or vice-versa). Mapped to 422 Unprocessable Entity so the admin
 *      catches the mismatch before delivery.
 *
 * Result shape: discriminated union — `{ outcome: 'ok', variables }` on
 * success (variables echoed for type narrowing), `{ outcome: 'failed',
 * issues }` on failure (issues echoed with field path + reason).
 */
@Injectable()
export class VariableValidatorService {
  validate(input: ValidateInput): VariableValidationResult {
    const issues: VariableValidationIssue[] = [];

    const supplied = input.variables ?? {};
    const suppliedNames = new Set(Object.keys(supplied));
    const declaredNames = new Set(input.schema.map((entry) => entry.name));

    // Missing required variables.
    for (const entry of input.schema) {
      if (!entry.required) continue;
      if (!suppliedNames.has(entry.name)) {
        issues.push({
          kind: 'missing_required',
          variableName: entry.name,
          message: `variable '${entry.name}' is required by the template`,
        });
      }
    }

    // Unknown variables.
    for (const suppliedName of suppliedNames) {
      if (!declaredNames.has(suppliedName)) {
        issues.push({
          kind: 'unknown_variable',
          variableName: suppliedName,
          message: `variable '${suppliedName}' is not declared by the template`,
        });
      }
    }

    // Type mismatches — only for variables that are both declared and
    // supplied. Missing-required + unknown are reported separately
    // above; we don't re-report them as type mismatches.
    for (const entry of input.schema) {
      if (!suppliedNames.has(entry.name)) continue;
      const value = supplied[entry.name];
      if (!typeMatches(value, entry.type)) {
        issues.push({
          kind: 'type_mismatch',
          variableName: entry.name,
          expectedType: entry.type,
          actualType: jsTypeOf(value),
          message: `variable '${entry.name}' expects ${entry.type} but received ${jsTypeOf(value)}`,
        });
      }
    }

    if (issues.length > 0) {
      return { outcome: 'failed', issues };
    }

    return {
      outcome: 'ok',
      // Echo a copy so the caller can rely on object identity for
      // downstream caching without worrying about the input shape
      // being mutated upstream.
      variables: { ...supplied },
    };
  }
}

function typeMatches(value: unknown, expected: NotificationVariableEntry['type']): boolean {
  switch (expected) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
  }
}

/**
 * Narrowed string representation of the JS type — used in the issue
 * message so the admin sees `string` / `number` / `boolean` / `null` /
 * `array` / `object` instead of the JS-runtime `object` umbrella.
 */
function jsTypeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number' && !Number.isFinite(value)) return 'non_finite_number';
  return typeof value;
}

// ─── I/O shapes ─────────────────────────────────────────────────────────

export interface ValidateInput {
  readonly schema: readonly NotificationVariableEntry[];
  readonly variables: Readonly<Record<string, RenderVariableValue>> | undefined;
}

export type VariableValidationResult =
  | {
      readonly outcome: 'ok';
      readonly variables: Readonly<Record<string, RenderVariableValue>>;
    }
  | { readonly outcome: 'failed'; readonly issues: readonly VariableValidationIssue[] };

export type VariableValidationIssue =
  | {
      readonly kind: 'missing_required';
      readonly variableName: string;
      readonly message: string;
    }
  | {
      readonly kind: 'unknown_variable';
      readonly variableName: string;
      readonly message: string;
    }
  | {
      readonly kind: 'type_mismatch';
      readonly variableName: string;
      readonly expectedType: NotificationVariableEntry['type'];
      readonly actualType: string;
      readonly message: string;
    };
