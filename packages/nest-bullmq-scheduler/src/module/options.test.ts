import { describe, expect, it } from 'vitest';

import {
  BullMqSchedulerConfigError,
  validateBullMqSchedulerOptions,
  type BullMqSchedulerModuleOptions,
} from './options';

function build(
  overrides: Partial<BullMqSchedulerModuleOptions> = {},
): BullMqSchedulerModuleOptions {
  return {
    serviceName: 'service-identity',
    environment: 'prod',
    redisUrl: 'redis://cache:6379/0',
    ...overrides,
  };
}

describe('validateBullMqSchedulerOptions', () => {
  it('derives the CLAUDE.md §3.7 prefix as {env}:{service}:queue', () => {
    expect(validateBullMqSchedulerOptions(build()).prefix).toBe('prod:service-identity:queue');
  });

  it('freezes the result so no consumer mutates the shared prefix', () => {
    const validated = validateBullMqSchedulerOptions(build());

    expect(Object.isFrozen(validated)).toBe(true);
  });

  it.each([
    ['serviceName', { serviceName: '' }],
    ['serviceName whitespace', { serviceName: '   ' }],
    ['environment', { environment: '' }],
  ])('rejects an empty %s — a default would put queues in another keyspace', (_label, override) => {
    expect(() => validateBullMqSchedulerOptions(build(override))).toThrow(
      BullMqSchedulerConfigError,
    );
  });

  it('rejects a colon inside a segment — it would forge an extra namespace level', () => {
    expect(() => validateBullMqSchedulerOptions(build({ serviceName: 'svc:identity' }))).toThrow(
      /must not contain/,
    );
    expect(() => validateBullMqSchedulerOptions(build({ environment: 'prod:eu' }))).toThrow(
      /must not contain/,
    );
  });

  it('accepts rediss:// for a TLS connection', () => {
    expect(
      validateBullMqSchedulerOptions(build({ redisUrl: 'rediss://cache:6379' })).redisUrl,
    ).toBe('rediss://cache:6379');
  });

  it('rejects a non-redis URL scheme', () => {
    expect(() => validateBullMqSchedulerOptions(build({ redisUrl: 'https://cache:6379' }))).toThrow(
      /redis: or rediss:/,
    );
  });

  it('rejects an unparseable redisUrl', () => {
    expect(() => validateBullMqSchedulerOptions(build({ redisUrl: 'not a url' }))).toThrow(
      /must be a valid URL/,
    );
  });

  it('rejects an empty redisUrl', () => {
    expect(() => validateBullMqSchedulerOptions(build({ redisUrl: '' }))).toThrow(
      /non-empty string/,
    );
  });

  it('names the package in every error so a boot failure is attributable', () => {
    expect(() => validateBullMqSchedulerOptions(build({ serviceName: '' }))).toThrow(
      /@taste-and-see\/nest-bullmq-scheduler/,
    );
  });
});
