import type { Breadcrumb, Event } from '@sentry/node';
import { describe, expect, it } from 'vitest';

import { REDACTION_CENSOR } from './redaction';
import { scrubBreadcrumb, scrubQueryString, scrubSentryEvent, scrubUrl, scrubValue } from './scrub';

describe('scrubValue', () => {
  it('censors a sensitive key at the top level', () => {
    expect(scrubValue({ password: 'hunter2', bookingId: 'bk_1' })).toEqual({
      password: REDACTION_CENSOR,
      bookingId: 'bk_1',
    });
  });

  it('censors at ARBITRARY depth, which is where it beats the logger rules', () => {
    // pino's `*.field` wildcard reaches one level. A Sentry event routinely
    // nests further than that, and this is the case the two-list drift
    // argument turns on.
    const scrubbed = scrubValue({
      extra: { request: { body: { household: { senior: { email: 'a@b.test' } } } } },
    });
    expect(scrubbed).toEqual({
      extra: { request: { body: { household: { senior: { email: REDACTION_CENSOR } } } } },
    });
  });

  it('walks into arrays', () => {
    expect(scrubValue([{ ssn: '000-00-0000' }, { providerId: 'pr_1' }])).toEqual([
      { ssn: REDACTION_CENSOR },
      { providerId: 'pr_1' },
    ]);
  });

  it('survives a cycle instead of taking the process down with the error it was reporting', () => {
    const cyclic: Record<string, unknown> = { token: 'sk_live_x', name: 'loop' };
    cyclic['self'] = cyclic;
    const scrubbed = scrubValue(cyclic) as Record<string, unknown>;
    expect(scrubbed['token']).toBe(REDACTION_CENSOR);
    expect(scrubbed['self']).toBe('[Circular]');
  });

  it('marks depth truncation distinctly from redaction', () => {
    // A depth bail-out that returned the value would make MAX_DEPTH a PII
    // bypass; one that returned the redaction censor would tell the operator
    // the wrong reason.
    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 20; i += 1) deep = { nested: deep };
    expect(JSON.stringify(scrubValue(deep))).toContain('[REDACTED:max-depth]');
  });

  it('leaves primitives and exotic instances structurally intact', () => {
    const date = new Date(0);
    const scrubbed = scrubValue({ when: date, count: 3, ok: false, missing: null }) as Record<
      string,
      unknown
    >;
    expect(scrubbed['when']).toBe(date);
    expect(scrubbed['count']).toBe(3);
    expect(scrubbed['ok']).toBe(false);
    expect(scrubbed['missing']).toBeNull();
  });
});

describe('scrubQueryString', () => {
  it('censors a credential param in the raw string form', () => {
    // The form that matters most: a password-reset or magic-link URL is
    // `?token=...` by construction.
    expect(scrubQueryString('token=abc123&page=2')).toBe(
      `token=${encodeURIComponent(REDACTION_CENSOR)}&page=2`,
    );
  });

  it('returns the original string untouched when nothing matched', () => {
    // Round-tripping through URLSearchParams re-encodes; a no-op must stay a
    // no-op or every event's query string changes shape for no reason.
    expect(scrubQueryString('page=2&sort=name%20asc')).toBe('page=2&sort=name%20asc');
  });

  it('handles a leading question mark', () => {
    expect(scrubQueryString('?apiKey=k')).toContain(encodeURIComponent(REDACTION_CENSOR));
  });

  it('censors the tuple form', () => {
    expect(
      scrubQueryString([
        ['secret', 's'],
        ['page', '2'],
      ]),
    ).toEqual([
      ['secret', REDACTION_CENSOR],
      ['page', '2'],
    ]);
  });

  it('censors the object form', () => {
    expect(scrubQueryString({ password: 'p', page: '2' })).toEqual({
      password: REDACTION_CENSOR,
      page: '2',
    });
  });
});

describe('scrubUrl', () => {
  it('strips a credential from the query while preserving the path', () => {
    expect(scrubUrl('https://app.test/reset?token=abc&id=7')).toBe(
      `https://app.test/reset?token=${encodeURIComponent(REDACTION_CENSOR)}&id=7`,
    );
  });

  it('leaves a URL with no query alone', () => {
    expect(scrubUrl('https://app.test/bookings/bk_1')).toBe('https://app.test/bookings/bk_1');
  });
});

describe('scrubSentryEvent', () => {
  it('censors request headers, cookies and body together', () => {
    const event: Event = {
      request: {
        url: 'https://api.test/v1/auth/login',
        method: 'POST',
        headers: {
          authorization: 'Bearer ey.J.x',
          'x-internal-api-key': 'k_live',
          'x-ts-actor-user-id': 'usr_1',
          'content-type': 'application/json',
        },
        cookies: { session: 'abc' },
        data: { email: 'a@b.test', password: 'hunter2', rememberMe: true },
      },
    };

    const scrubbed = scrubSentryEvent(event);
    const headers = scrubbed.request?.headers as Record<string, string>;
    expect(headers['authorization']).toBe(REDACTION_CENSOR);
    expect(headers['x-internal-api-key']).toBe(REDACTION_CENSOR);
    expect(headers['x-ts-actor-user-id']).toBe('usr_1');
    expect(headers['content-type']).toBe('application/json');
    expect(scrubbed.request?.cookies).toBe(REDACTION_CENSOR);

    const data = scrubbed.request?.data as Record<string, unknown>;
    expect(data['password']).toBe(REDACTION_CENSOR);
    expect(data['email']).toBe(REDACTION_CENSOR);
    expect(data['rememberMe']).toBe(true);
  });

  it('scrubs a raw JSON string body', () => {
    const scrubbed = scrubSentryEvent({
      request: { data: JSON.stringify({ password: 'p', bookingId: 'bk_1' }) },
    });
    expect(JSON.parse(scrubbed.request?.data as string)).toEqual({
      password: REDACTION_CENSOR,
      bookingId: 'bk_1',
    });
  });

  it('leaves a non-JSON string body alone rather than destroying the diagnostic', () => {
    const scrubbed = scrubSentryEvent({ request: { data: 'not json at all' } });
    expect(scrubbed.request?.data).toBe('not json at all');
  });

  it('drops user.ip_address even when a call site set it explicitly', () => {
    // `sendDefaultPii: false` stops the SDK attaching it; it does not stop
    // `Sentry.setUser({ ip_address })`. This is the backstop.
    const scrubbed = scrubSentryEvent({
      user: { id: 'usr_1', ip_address: '203.0.113.7', email: 'a@b.test' },
    });
    expect(scrubbed.user?.ip_address).toBeUndefined();
    expect(scrubbed.user?.email).toBe(REDACTION_CENSOR);
    expect(scrubbed.user?.id).toBe('usr_1');
  });

  it('censors local variables if a frame ever carries them', () => {
    // `localVariablesIntegration` is deliberately NOT enabled, so this should
    // never fire in production. Asserted anyway: if someone enables it, the
    // well-named half is still covered rather than shipping in the clear.
    const scrubbed = scrubSentryEvent({
      exception: {
        values: [
          {
            type: 'Error',
            value: 'boom',
            stacktrace: {
              frames: [{ function: 'login', vars: { password: 'hunter2', attempt: 2 } }],
            },
          },
        ],
      },
    });
    const vars = scrubbed.exception?.values?.[0]?.stacktrace?.frames?.[0]?.vars as Record<
      string,
      unknown
    >;
    expect(vars['password']).toBe(REDACTION_CENSOR);
    expect(vars['attempt']).toBe(2);
  });

  it('censors breadcrumb data, the surface that accumulates silently', () => {
    const scrubbed = scrubSentryEvent({
      breadcrumbs: [{ category: 'http', data: { url: 'https://x.test', apiKey: 'k' } }],
    });
    const data = scrubbed.breadcrumbs?.[0]?.data as Record<string, unknown>;
    expect(data['apiKey']).toBe(REDACTION_CENSOR);
    expect(data['url']).toBe('https://x.test');
  });

  it('never returns null — the scrub makes an error reportable, it does not suppress it', () => {
    expect(scrubSentryEvent({ message: 'anything' })).not.toBeNull();
  });

  it('preserves the fields that make an event routable', () => {
    const scrubbed = scrubSentryEvent({
      event_id: 'e1',
      release: 'service-identity@1.2.3',
      environment: 'production',
      tags: { service: 'service-identity', otel_trace_id: 'abc' },
    });
    expect(scrubbed.event_id).toBe('e1');
    expect(scrubbed.release).toBe('service-identity@1.2.3');
    expect(scrubbed.environment).toBe('production');
    expect(scrubbed.tags).toEqual({ service: 'service-identity', otel_trace_id: 'abc' });
  });

  it('does not mutate the event it was given', () => {
    const event: Event = { request: { data: { password: 'hunter2' } } };
    scrubSentryEvent(event);
    expect((event.request?.data as Record<string, unknown>)['password']).toBe('hunter2');
  });
});

describe('scrubBreadcrumb', () => {
  it('censors data', () => {
    const crumb: Breadcrumb = { category: 'query', data: { token: 't', rows: 3 } };
    expect(scrubBreadcrumb(crumb).data).toEqual({ token: REDACTION_CENSOR, rows: 3 });
  });

  it('passes a data-less breadcrumb through untouched', () => {
    const crumb: Breadcrumb = { category: 'navigation', message: 'to /dashboard' };
    expect(scrubBreadcrumb(crumb)).toBe(crumb);
  });
});
