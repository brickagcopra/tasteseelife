import 'reflect-metadata';

import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';

import { TenantContextConfigError, type ValidatedOptions } from '../config';
import { TenantContextStore } from '../context/context-store';
import { TenantContextModule } from './tenant-context.module';
import { TENANT_CONTEXT_OPTIONS_TOKEN, TENANT_CONTEXT_STORE_TOKEN } from './tokens';

describe('TenantContextModule.forRoot', () => {
  it('compiles with valid options and exposes the store + options', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        TenantContextModule.forRoot({
          serviceName: 'service-test',
          environment: 'test',
        }),
      ],
    }).compile();

    const store = moduleRef.get<TenantContextStore>(TENANT_CONTEXT_STORE_TOKEN);
    const options = moduleRef.get<ValidatedOptions>(TENANT_CONTEXT_OPTIONS_TOKEN);

    expect(store).toBeInstanceOf(TenantContextStore);
    expect(options.serviceName).toBe('service-test');
    expect(options.environment).toBe('test');
    expect(options.enforcement).toBe('audit');
  });

  it('applies the enforce mode override', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        TenantContextModule.forRoot({
          serviceName: 'service-test',
          environment: 'prod',
          enforcement: 'enforce',
          unscopedModels: ['Plan', 'ChartOfAccount'],
        }),
      ],
    }).compile();

    const options = moduleRef.get<ValidatedOptions>(TENANT_CONTEXT_OPTIONS_TOKEN);
    expect(options.enforcement).toBe('enforce');
    expect(options.unscopedModels).toEqual(['Plan', 'ChartOfAccount']);
  });

  it('throws TenantContextConfigError synchronously on invalid options', () => {
    expect(() =>
      TenantContextModule.forRoot({
        serviceName: '',
        environment: 'test',
      }),
    ).toThrow(TenantContextConfigError);
  });

  it('provides the store as a singleton — repeated lookups return the same instance', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        TenantContextModule.forRoot({
          serviceName: 'service-test',
          environment: 'test',
        }),
      ],
    }).compile();

    const a = moduleRef.get<TenantContextStore>(TENANT_CONTEXT_STORE_TOKEN);
    const b = moduleRef.get<TenantContextStore>(TENANT_CONTEXT_STORE_TOKEN);
    expect(a).toBe(b);
  });

  it('exports the options as a frozen object (defensive — the validated config should be immutable)', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        TenantContextModule.forRoot({
          serviceName: 'service-test',
          environment: 'test',
          unscopedModels: ['Plan'],
        }),
      ],
    }).compile();

    const options = moduleRef.get<ValidatedOptions>(TENANT_CONTEXT_OPTIONS_TOKEN);
    expect(Object.isFrozen(options.unscopedModels)).toBe(true);
    expect(Object.isFrozen(options.unscopedOperations)).toBe(true);
  });
});
