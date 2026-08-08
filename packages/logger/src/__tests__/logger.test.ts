import { Writable } from 'node:stream';

import { beforeEach, describe, expect, it } from 'vitest';

import { createLogger, REDACTION_CENSOR, withContext } from '../index';

class CaptureStream extends Writable {
  public readonly records: Array<Record<string, unknown>> = [];

  override _write(chunk: Buffer, _enc: BufferEncoding, cb: () => void): void {
    const text = chunk.toString();
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      this.records.push(JSON.parse(trimmed) as Record<string, unknown>);
    }
    cb();
  }
}

const firstRecord = (capture: CaptureStream): Record<string, unknown> => {
  const record = capture.records[0];
  expect(record).toBeDefined();
  return record as Record<string, unknown>;
};

describe('createLogger — emission shape', () => {
  let capture: CaptureStream;

  beforeEach(() => {
    capture = new CaptureStream();
  });

  it('emits structured JSON with service / env / version bindings and ISO time', () => {
    const logger = createLogger({
      service: 'service-test',
      env: 'test',
      version: '0.0.1',
      destination: capture,
    });

    logger.info('hello');

    const record = firstRecord(capture);
    expect(record).toMatchObject({
      service: 'service-test',
      env: 'test',
      version: '0.0.1',
      level: 'info',
      msg: 'hello',
    });
    expect(typeof record['time']).toBe('string');
    expect(record['time']).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('emits level as a label string, not a number', () => {
    const logger = createLogger({ service: 'svc', destination: capture });
    logger.warn('careful');
    expect(firstRecord(capture)['level']).toBe('warn');
  });

  it('honours per-instance base bindings', () => {
    const logger = createLogger({
      service: 'svc',
      base: { region: 'us-east-1', podId: 'pod_xyz' },
      destination: capture,
    });
    logger.info('boot');
    const record = firstRecord(capture);
    expect(record['region']).toBe('us-east-1');
    expect(record['podId']).toBe('pod_xyz');
  });
});

describe('createLogger — PII redaction', () => {
  let capture: CaptureStream;

  beforeEach(() => {
    capture = new CaptureStream();
  });

  const log = (payload: Record<string, unknown>): Record<string, unknown> => {
    const logger = createLogger({ service: 'svc', destination: capture });
    logger.info(payload, 'event');
    return firstRecord(capture);
  };

  it('redacts auth credentials at top level and one level deep', () => {
    const record = log({
      password: 'super-secret',
      passwordHash: '$2b$12$abc',
      token: 'abc',
      accessToken: 'eyJhbGciOi...',
      refreshToken: 'rt_abc',
      jwt: 'jwt_value',
      apiKey: 'k_live_xxx',
      secret: 'sh!',
      user: { password: 'nested', accessToken: 'nested-token' },
    });

    expect(record['password']).toBe(REDACTION_CENSOR);
    expect(record['passwordHash']).toBe(REDACTION_CENSOR);
    expect(record['token']).toBe(REDACTION_CENSOR);
    expect(record['accessToken']).toBe(REDACTION_CENSOR);
    expect(record['refreshToken']).toBe(REDACTION_CENSOR);
    expect(record['jwt']).toBe(REDACTION_CENSOR);
    expect(record['apiKey']).toBe(REDACTION_CENSOR);
    expect(record['secret']).toBe(REDACTION_CENSOR);

    const user = record['user'] as Record<string, unknown>;
    expect(user['password']).toBe(REDACTION_CENSOR);
    expect(user['accessToken']).toBe(REDACTION_CENSOR);
  });

  it('redacts Authorization and Cookie headers from req / res / headers payloads', () => {
    const record = log({
      req: {
        headers: { authorization: 'Bearer abc', cookie: 'sid=xyz', accept: 'application/json' },
      },
      res: { headers: { 'set-cookie': 'sid=new' } },
      headers: { authorization: 'Bearer plain', cookie: 'sid=plain' },
    });

    const reqHeaders = (record['req'] as { headers: Record<string, unknown> }).headers;
    const resHeaders = (record['res'] as { headers: Record<string, unknown> }).headers;
    const headers = record['headers'] as Record<string, unknown>;

    expect(reqHeaders['authorization']).toBe(REDACTION_CENSOR);
    expect(reqHeaders['cookie']).toBe(REDACTION_CENSOR);
    expect(reqHeaders['accept']).toBe('application/json');

    expect(resHeaders['set-cookie']).toBe(REDACTION_CENSOR);

    expect(headers['authorization']).toBe(REDACTION_CENSOR);
    expect(headers['cookie']).toBe(REDACTION_CENSOR);
  });

  it('redacts personal identifiers (ssn, dob, email, phone) at top level and nested', () => {
    const record = log({
      ssn: '123-45-6789',
      dob: '1955-03-21',
      email: 'alice@example.com',
      phone: '+15551234567',
      user: { email: 'b@c.com', dob: '1950-01-01', ssn: '111-22-3333' },
    });

    expect(record['ssn']).toBe(REDACTION_CENSOR);
    expect(record['dob']).toBe(REDACTION_CENSOR);
    expect(record['email']).toBe(REDACTION_CENSOR);
    expect(record['phone']).toBe(REDACTION_CENSOR);

    const user = record['user'] as Record<string, unknown>;
    expect(user['email']).toBe(REDACTION_CENSOR);
    expect(user['dob']).toBe(REDACTION_CENSOR);
    expect(user['ssn']).toBe(REDACTION_CENSOR);
  });

  it('redacts payment-card primitives (PAN, CVV, cardholder)', () => {
    const record = log({
      cardNumber: '4242424242424242',
      pan: '4111111111111111',
      cvv: '123',
      cvc: '456',
      cardholderName: 'Alice Doe',
    });

    expect(record['cardNumber']).toBe(REDACTION_CENSOR);
    expect(record['pan']).toBe(REDACTION_CENSOR);
    expect(record['cvv']).toBe(REDACTION_CENSOR);
    expect(record['cvc']).toBe(REDACTION_CENSOR);
    expect(record['cardholderName']).toBe(REDACTION_CENSOR);
  });

  it('redacts health-flagged senior data (dementiaStatus, medicalNotes, allergies, medications)', () => {
    const record = log({
      dementiaStatus: 'mild',
      medicalNotes: 'low sodium diet',
      allergies: 'peanuts',
      medications: 'aspirin',
      senior: { dementiaStatus: 'moderate', medicalNotes: 'see chart' },
    });

    expect(record['dementiaStatus']).toBe(REDACTION_CENSOR);
    expect(record['medicalNotes']).toBe(REDACTION_CENSOR);
    expect(record['allergies']).toBe(REDACTION_CENSOR);
    expect(record['medications']).toBe(REDACTION_CENSOR);

    const senior = record['senior'] as Record<string, unknown>;
    expect(senior['dementiaStatus']).toBe(REDACTION_CENSOR);
    expect(senior['medicalNotes']).toBe(REDACTION_CENSOR);
  });

  it('preserves the field shape (does not remove keys) so log analytics see presence', () => {
    const record = log({ password: 'x', email: 'a@b.com' });
    expect(Object.keys(record)).toEqual(expect.arrayContaining(['password', 'email']));
    expect(record['password']).toBe(REDACTION_CENSOR);
    expect(record['email']).toBe(REDACTION_CENSOR);
  });

  it('does not redact correlation fields or non-PII identifiers', () => {
    const record = log({
      traceId: 'trace-1',
      spanId: 'span-1',
      requestId: 'req-1',
      actorId: 'user_abc',
      tenantScope: 'household_123',
      bookingId: 'bk_xyz',
      providerId: 'prov_456',
    });

    expect(record['traceId']).toBe('trace-1');
    expect(record['spanId']).toBe('span-1');
    expect(record['requestId']).toBe('req-1');
    expect(record['actorId']).toBe('user_abc');
    expect(record['tenantScope']).toBe('household_123');
    expect(record['bookingId']).toBe('bk_xyz');
    expect(record['providerId']).toBe('prov_456');
  });

  it('accepts an extended redactPaths list without losing defaults when consumers spread', () => {
    const logger = createLogger({
      service: 'svc',
      destination: capture,
      redactPaths: [...['customSecret', 'nested.thing'], 'password'],
    });
    logger.info({ password: 'pw', customSecret: 'cs', nested: { thing: 'nt' } }, 'extended');
    const record = firstRecord(capture);
    expect(record['password']).toBe(REDACTION_CENSOR);
    expect(record['customSecret']).toBe(REDACTION_CENSOR);
    const nested = record['nested'] as Record<string, unknown>;
    expect(nested['thing']).toBe(REDACTION_CENSOR);
  });
});

describe('withContext — correlation propagation', () => {
  it('attaches all five correlation fields when provided', () => {
    const capture = new CaptureStream();
    const logger = createLogger({ service: 'svc', destination: capture });
    const scoped = withContext(logger, {
      traceId: 't1',
      spanId: 's1',
      requestId: 'r1',
      actorId: 'u1',
      tenantScope: 'p1',
    });

    scoped.info('scoped');
    const record = firstRecord(capture);
    expect(record).toMatchObject({
      traceId: 't1',
      spanId: 's1',
      requestId: 'r1',
      actorId: 'u1',
      tenantScope: 'p1',
      msg: 'scoped',
    });
  });

  it('omits undefined correlation fields rather than emitting null / undefined', () => {
    const capture = new CaptureStream();
    const logger = createLogger({ service: 'svc', destination: capture });
    const scoped = withContext(logger, { traceId: 't1', actorId: 'u1' });

    scoped.info('partial');
    const record = firstRecord(capture);
    expect(record['traceId']).toBe('t1');
    expect(record['actorId']).toBe('u1');
    expect(record).not.toHaveProperty('spanId');
    expect(record).not.toHaveProperty('requestId');
    expect(record).not.toHaveProperty('tenantScope');
  });

  it('child loggers continue to apply redaction inherited from the parent', () => {
    const capture = new CaptureStream();
    const logger = createLogger({ service: 'svc', destination: capture });
    const scoped = withContext(logger, { traceId: 't1' });

    scoped.info({ password: 'pw', email: 'a@b.com' }, 'scoped+pii');

    const record = firstRecord(capture);
    expect(record['traceId']).toBe('t1');
    expect(record['password']).toBe(REDACTION_CENSOR);
    expect(record['email']).toBe(REDACTION_CENSOR);
  });
});
