import { describe, expect, it } from 'vitest';
import type { RequestContext } from '@taste-and-see/auth-sdk';

import type { TenantContextFrame } from '../context/context-store';
import { evaluateGate, toReadonlySet, type GateInputs } from './gate';

const scopedFrame = (): TenantContextFrame => ({
  kind: 'scoped',
  context: {
    userId: 'usr_1',
    mfaVerified: true,
    roles: [],
    tenantScope: { type: 'global' },
  } as RequestContext,
});

const exemptFrame = (reason: string): TenantContextFrame => ({ kind: 'exempt', reason });

const defaults = (overrides: Partial<GateInputs> = {}): GateInputs => ({
  frame: null,
  model: 'Booking',
  operation: 'findUnique',
  enforcement: 'audit',
  unscopedModels: toReadonlySet([]),
  unscopedOperations: toReadonlySet(['$queryRaw', '$executeRaw']),
  ...overrides,
});

describe('evaluateGate', () => {
  describe('happy paths', () => {
    it('returns proceed_scoped when a scoped frame is present', () => {
      const decision = evaluateGate(defaults({ frame: scopedFrame() }));
      expect(decision.outcome).toBe('proceed_scoped');
    });

    it('returns proceed_exempt when an exempt frame is present', () => {
      const decision = evaluateGate(defaults({ frame: exemptFrame('seed-rbac') }));
      expect(decision.outcome).toBe('proceed_exempt');
      if (decision.outcome === 'proceed_exempt') {
        expect(decision.reason).toBe('seed-rbac');
      }
    });

    it('returns proceed_unscoped_model when the model is on the allow-list', () => {
      const decision = evaluateGate(
        defaults({ model: 'Plan', unscopedModels: toReadonlySet(['Plan']) }),
      );
      expect(decision.outcome).toBe('proceed_unscoped_model');
      if (decision.outcome === 'proceed_unscoped_model') {
        expect(decision.model).toBe('Plan');
      }
    });

    it('returns proceed_unscoped_operation for a raw query', () => {
      const decision = evaluateGate(defaults({ operation: '$queryRaw', model: undefined }));
      expect(decision.outcome).toBe('proceed_unscoped_operation');
      if (decision.outcome === 'proceed_unscoped_operation') {
        expect(decision.operation).toBe('$queryRaw');
      }
    });
  });

  describe('no-context paths', () => {
    it('returns block when enforce + no frame + scoped model', () => {
      const decision = evaluateGate(defaults({ enforcement: 'enforce' }));
      expect(decision.outcome).toBe('block');
    });

    it('returns proceed_with_warning when audit + no frame', () => {
      const decision = evaluateGate(defaults({ enforcement: 'audit' }));
      expect(decision.outcome).toBe('proceed_with_warning');
    });
  });

  describe('precedence', () => {
    it('unscoped operation wins over enforce mode (raw SQL is always allowed)', () => {
      const decision = evaluateGate(
        defaults({ operation: '$queryRaw', enforcement: 'enforce', model: undefined }),
      );
      expect(decision.outcome).toBe('proceed_unscoped_operation');
    });

    it('unscoped operation wins over an active scoped frame', () => {
      const decision = evaluateGate(
        defaults({ operation: '$queryRaw', frame: scopedFrame(), model: undefined }),
      );
      expect(decision.outcome).toBe('proceed_unscoped_operation');
    });

    it('unscoped model wins over enforce mode', () => {
      const decision = evaluateGate(
        defaults({
          enforcement: 'enforce',
          model: 'ChartOfAccount',
          unscopedModels: toReadonlySet(['ChartOfAccount']),
        }),
      );
      expect(decision.outcome).toBe('proceed_unscoped_model');
    });

    it('unscoped model wins over an active scoped frame (still useful for catalog reads)', () => {
      const decision = evaluateGate(
        defaults({
          frame: scopedFrame(),
          model: 'Plan',
          unscopedModels: toReadonlySet(['Plan']),
        }),
      );
      expect(decision.outcome).toBe('proceed_unscoped_model');
    });

    it('exempt frame wins over enforce mode', () => {
      const decision = evaluateGate(
        defaults({ enforcement: 'enforce', frame: exemptFrame('seed') }),
      );
      expect(decision.outcome).toBe('proceed_exempt');
    });

    it('scoped frame proceeds even when model is undefined (e.g. transactions)', () => {
      const decision = evaluateGate(
        defaults({ frame: scopedFrame(), model: undefined, operation: 'aggregate' }),
      );
      expect(decision.outcome).toBe('proceed_scoped');
    });
  });

  describe('edge cases', () => {
    it('handles an empty unscopedOperations set', () => {
      const decision = evaluateGate(
        defaults({ operation: '$queryRaw', unscopedOperations: toReadonlySet([]) }),
      );
      // Raw operations only get a free pass when explicitly listed —
      // never assume the gate exempts them. Caller controls the list.
      expect(decision.outcome).toBe('proceed_with_warning');
    });

    it('treats a model name not in the allow-list normally', () => {
      const decision = evaluateGate(defaults({ unscopedModels: toReadonlySet(['Plan']) }));
      expect(decision.outcome).toBe('proceed_with_warning');
    });

    it('blocks unknown models in enforce mode', () => {
      const decision = evaluateGate(defaults({ enforcement: 'enforce', model: 'Booking' }));
      expect(decision.outcome).toBe('block');
    });
  });
});

describe('toReadonlySet', () => {
  it('returns a Set that contains every input', () => {
    const input: readonly string[] = ['a', 'b', 'c'];
    const set = toReadonlySet(input);
    expect(set.has('a')).toBe(true);
    expect(set.has('b')).toBe(true);
    expect(set.has('c')).toBe(true);
    expect(set.has('d')).toBe(false);
  });

  it('returns an empty set for an empty input', () => {
    const set = toReadonlySet([]);
    expect(set.size).toBe(0);
  });

  it('de-duplicates repeated values', () => {
    const set = toReadonlySet(['a', 'a', 'b']);
    expect(set.size).toBe(2);
  });
});
