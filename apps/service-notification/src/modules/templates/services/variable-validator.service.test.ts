import { describe, expect, it, beforeEach } from 'vitest';

import { VariableValidatorService } from './variable-validator.service';

describe('VariableValidatorService', () => {
  let svc: VariableValidatorService;

  beforeEach(() => {
    svc = new VariableValidatorService();
  });

  it('accepts a fully-populated variables map matching the schema', () => {
    const result = svc.validate({
      schema: [
        { name: 'firstName', type: 'string', required: true },
        { name: 'balance', type: 'number', required: true },
        { name: 'verified', type: 'boolean', required: false },
      ],
      variables: { firstName: 'Alice', balance: 100, verified: true },
    });
    expect(result.outcome).toBe('ok');
  });

  it('accepts when only required variables are present (optional omitted)', () => {
    const result = svc.validate({
      schema: [
        { name: 'firstName', type: 'string', required: true },
        { name: 'verified', type: 'boolean', required: false },
      ],
      variables: { firstName: 'Alice' },
    });
    expect(result.outcome).toBe('ok');
  });

  it('accepts an empty variables map when the schema declares no variables', () => {
    const result = svc.validate({ schema: [], variables: undefined });
    expect(result.outcome).toBe('ok');
  });

  it('flags a missing required variable', () => {
    const result = svc.validate({
      schema: [{ name: 'firstName', type: 'string', required: true }],
      variables: {},
    });
    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.issues.length).toBe(1);
      expect(result.issues[0]?.kind).toBe('missing_required');
      expect(result.issues[0]?.variableName).toBe('firstName');
    }
  });

  it('flags an unknown variable', () => {
    const result = svc.validate({
      schema: [{ name: 'firstName', type: 'string', required: true }],
      variables: { firstName: 'Alice', surprise: 'value' },
    });
    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.issues.length).toBe(1);
      expect(result.issues[0]?.kind).toBe('unknown_variable');
      expect(result.issues[0]?.variableName).toBe('surprise');
    }
  });

  it('flags a type mismatch (string supplied for number slot)', () => {
    const result = svc.validate({
      schema: [{ name: 'balance', type: 'number', required: true }],
      // The runtime input shape is `Record<string, RenderVariableValue>` =
      // `Record<string, string | number | boolean>`. We exercise a
      // type-mismatch by handing a string where a number is declared.
      variables: { balance: '100' as unknown as number },
    });
    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      const issue = result.issues[0];
      expect(issue?.kind).toBe('type_mismatch');
      if (issue?.kind === 'type_mismatch') {
        expect(issue.expectedType).toBe('number');
        expect(issue.actualType).toBe('string');
      }
    }
  });

  it('flags a type mismatch (boolean supplied for string slot)', () => {
    const result = svc.validate({
      schema: [{ name: 'firstName', type: 'string', required: true }],
      variables: { firstName: true as unknown as string },
    });
    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.issues[0]?.kind).toBe('type_mismatch');
    }
  });

  it('does NOT flag a type mismatch for a missing-but-optional variable', () => {
    const result = svc.validate({
      schema: [{ name: 'firstName', type: 'string', required: false }],
      variables: {},
    });
    expect(result.outcome).toBe('ok');
  });

  it('reports multiple issues in one pass (missing + unknown)', () => {
    const result = svc.validate({
      schema: [
        { name: 'firstName', type: 'string', required: true },
        { name: 'balance', type: 'number', required: true },
      ],
      variables: { unknown: 'value' },
    });
    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      const kinds = result.issues.map((i) => i.kind);
      expect(kinds).toContain('missing_required');
      expect(kinds).toContain('unknown_variable');
    }
  });

  it('flags a non-finite number as a type mismatch (Infinity / NaN)', () => {
    const result = svc.validate({
      schema: [{ name: 'count', type: 'number', required: true }],
      variables: { count: Number.POSITIVE_INFINITY },
    });
    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.issues[0]?.kind).toBe('type_mismatch');
    }
  });

  it('echoes the validated variables map for downstream substitution', () => {
    const result = svc.validate({
      schema: [{ name: 'firstName', type: 'string', required: true }],
      variables: { firstName: 'Alice' },
    });
    expect(result.outcome).toBe('ok');
    if (result.outcome === 'ok') {
      expect(result.variables).toEqual({ firstName: 'Alice' });
    }
  });
});
