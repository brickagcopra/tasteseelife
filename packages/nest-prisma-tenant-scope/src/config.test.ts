import { describe, expect, it } from 'vitest';

import {
  DEFAULT_UNSCOPED_OPERATIONS,
  TenantContextConfigError,
  validateOptions,
  type TenantContextModuleOptions,
} from './config';

describe('validateOptions', () => {
  const baseOptions: TenantContextModuleOptions = {
    serviceName: 'service-test',
    environment: 'test',
  };

  it('accepts the minimal happy path and applies defaults', () => {
    const validated = validateOptions(baseOptions);

    expect(validated.serviceName).toBe('service-test');
    expect(validated.environment).toBe('test');
    expect(validated.enforcement).toBe('audit');
    expect(validated.unscopedModels).toEqual([]);
    expect(validated.unscopedOperations).toEqual(DEFAULT_UNSCOPED_OPERATIONS);
    expect(typeof validated.actorResolver).toBe('function');
  });

  it('passes through an explicit enforce mode', () => {
    const validated = validateOptions({ ...baseOptions, enforcement: 'enforce' });
    expect(validated.enforcement).toBe('enforce');
  });

  it('passes through unscopedModels', () => {
    const validated = validateOptions({
      ...baseOptions,
      unscopedModels: ['Plan', 'ChartOfAccount'],
    });
    expect(validated.unscopedModels).toEqual(['Plan', 'ChartOfAccount']);
  });

  it('passes through unscopedOperations override', () => {
    const validated = validateOptions({
      ...baseOptions,
      unscopedOperations: ['$queryRaw'],
    });
    expect(validated.unscopedOperations).toEqual(['$queryRaw']);
  });

  it('passes through actorResolver override', () => {
    const custom = (request: { requestContext?: unknown }): unknown => request.requestContext;
    const validated = validateOptions({
      ...baseOptions,
      actorResolver: custom,
    });
    expect(validated.actorResolver).toBe(custom);
  });

  it('returns frozen unscoped arrays so consumers cannot mutate the validated config', () => {
    const validated = validateOptions({
      ...baseOptions,
      unscopedModels: ['Plan'],
    });
    expect(Object.isFrozen(validated.unscopedModels)).toBe(true);
    expect(Object.isFrozen(validated.unscopedOperations)).toBe(true);
  });

  it('default actorResolver reads request.requestContext', () => {
    const validated = validateOptions(baseOptions);
    const ctx = { userId: 'usr_1' };
    expect(validated.actorResolver({ requestContext: ctx })).toBe(ctx);
    expect(validated.actorResolver({})).toBeUndefined();
  });

  it('rejects empty serviceName', () => {
    expect(() => validateOptions({ ...baseOptions, serviceName: '' })).toThrow(
      TenantContextConfigError,
    );
  });

  it('rejects empty environment', () => {
    expect(() => validateOptions({ ...baseOptions, environment: '' })).toThrow(
      TenantContextConfigError,
    );
  });

  it('rejects a serviceName over the 200-char cap', () => {
    expect(() => validateOptions({ ...baseOptions, serviceName: 'x'.repeat(201) })).toThrow(
      TenantContextConfigError,
    );
  });

  it('rejects an unknown enforcement mode', () => {
    expect(() =>
      validateOptions({
        ...baseOptions,
        enforcement: 'panic' as unknown as 'audit',
      }),
    ).toThrow(TenantContextConfigError);
  });

  it('rejects unscopedModels containing a non-string entry', () => {
    expect(() =>
      validateOptions({
        ...baseOptions,
        unscopedModels: ['Plan', 42 as unknown as string],
      }),
    ).toThrow(TenantContextConfigError);
  });

  it('rejects unscopedModels containing an empty string', () => {
    expect(() =>
      validateOptions({
        ...baseOptions,
        unscopedModels: ['Plan', ''],
      }),
    ).toThrow(TenantContextConfigError);
  });

  it('rejects unscopedOperations containing a non-string entry', () => {
    expect(() =>
      validateOptions({
        ...baseOptions,
        unscopedOperations: ['$queryRaw', null as unknown as string],
      }),
    ).toThrow(TenantContextConfigError);
  });

  it('rejects a non-function actorResolver', () => {
    expect(() =>
      validateOptions({
        ...baseOptions,
        actorResolver: 'nope' as unknown as (req: { requestContext?: unknown }) => unknown,
      }),
    ).toThrow(TenantContextConfigError);
  });

  it('aggregates every validation issue into the thrown error', () => {
    try {
      validateOptions({
        serviceName: '',
        environment: '',
        enforcement: 'panic' as unknown as 'audit',
      });
      throw new Error('expected validateOptions to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(TenantContextConfigError);
      const issues = (err as TenantContextConfigError).issues;
      expect(issues.length).toBeGreaterThanOrEqual(3);
    }
  });
});
