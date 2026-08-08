import type { TenantContextFrame } from '../context/context-store';
import type { TenantContextEnforcement } from '../config';

/**
 * The pure gate decision the Prisma extension wraps around every
 * operation. Separated into its own function so it can be unit-tested
 * exhaustively without spinning up a real Prisma client.
 *
 * Inputs:
 *   `frame`              — the current TenantContextFrame, or null.
 *   `model`              — the Prisma model name (undefined for raw ops).
 *   `operation`          — the Prisma operation name (`findMany`,
 *                          `$queryRaw`, etc.).
 *   `enforcement`        — `audit` or `enforce`.
 *   `unscopedModels`     — models the gate always allows.
 *   `unscopedOperations` — operations the gate always allows.
 *
 * Outputs (discriminated union):
 *
 *   `proceed_scoped`     — a RequestContext is in scope; row-level
 *                          filters (when a per-service follow-up wires
 *                          them up) consult the frame's `context`.
 *
 *   `proceed_exempt`     — the surrounding code is intentionally
 *                          unscoped (boot seed, worker, etc.).
 *
 *   `proceed_unscoped_model`     — the model is in the unscoped-models
 *                                  allow-list. Always allowed regardless
 *                                  of context.
 *
 *   `proceed_unscoped_operation` — the operation is a raw-SQL op (or in
 *                                  the unscoped-operations override).
 *                                  Always allowed.
 *
 *   `proceed_with_warning`       — no frame present + enforcement is
 *                                  `audit`. Caller logs and proceeds.
 *
 *   `block`                       — no frame present + enforcement is
 *                                   `enforce`. Caller throws.
 *
 * The order of checks matters:
 *   1. unscoped-operations (raw SQL is always allowed; even an
 *      enforce-mode service must permit it).
 *   2. unscoped-models (catalog tables are always allowed).
 *   3. exempt frame (explicit infra escape hatch — allowed unconditionally).
 *   4. scoped frame (the happy path).
 *   5. enforcement mode fallback (warn-and-proceed vs block).
 */
export type GateDecision =
  | { readonly outcome: 'proceed_scoped' }
  | { readonly outcome: 'proceed_exempt'; readonly reason: string }
  | { readonly outcome: 'proceed_unscoped_model'; readonly model: string }
  | { readonly outcome: 'proceed_unscoped_operation'; readonly operation: string }
  | { readonly outcome: 'proceed_with_warning' }
  | { readonly outcome: 'block' };

export interface GateInputs {
  readonly frame: TenantContextFrame | null;
  readonly model: string | undefined;
  readonly operation: string;
  readonly enforcement: TenantContextEnforcement;
  readonly unscopedModels: ReadonlySet<string>;
  readonly unscopedOperations: ReadonlySet<string>;
}

export function evaluateGate(input: GateInputs): GateDecision {
  if (input.unscopedOperations.has(input.operation)) {
    return { outcome: 'proceed_unscoped_operation', operation: input.operation };
  }
  if (input.model !== undefined && input.unscopedModels.has(input.model)) {
    return { outcome: 'proceed_unscoped_model', model: input.model };
  }
  if (input.frame !== null) {
    if (input.frame.kind === 'exempt') {
      return { outcome: 'proceed_exempt', reason: input.frame.reason };
    }
    return { outcome: 'proceed_scoped' };
  }
  if (input.enforcement === 'enforce') {
    return { outcome: 'block' };
  }
  return { outcome: 'proceed_with_warning' };
}

/**
 * Build a `ReadonlySet` from an array. Tiny helper so the public option
 * shape can stay array-typed (frozen array, easier to inspect at a
 * config dump site) while the runtime hot path uses an O(1) set.
 */
export function toReadonlySet<T extends string>(values: readonly T[]): ReadonlySet<T> {
  return new Set(values);
}
