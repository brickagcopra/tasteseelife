import { describe, expect, it } from 'vitest';

import type { Env } from '../../../config/env';
import { CertificatePdfStore } from './certificate-pdf-store';

function buildStore(nodeEnv = 'test'): CertificatePdfStore {
  return new CertificatePdfStore({ NODE_ENV: nodeEnv } as Env);
}

describe('CertificatePdfStore', () => {
  it('is stub-mode in Phase 1 (liveMode false)', () => {
    expect(buildStore().liveMode).toBe(false);
  });

  it('builds a deterministic, date-bucketed, env-prefixed key', () => {
    const key = buildStore('staging').buildCertificateKey({
      certificationId: 'cert_42',
      now: new Date('2026-06-08T12:00:00.000Z'),
    });
    expect(key).toBe('staging/academy_certificate/2026/06/cert_42.pdf');
  });

  it('zero-pads the month', () => {
    const key = buildStore().buildCertificateKey({
      certificationId: 'cert_1',
      now: new Date('2026-01-09T00:00:00.000Z'),
    });
    expect(key).toBe('test/academy_certificate/2026/01/cert_1.pdf');
  });

  it('store() returns the key (stub no-op)', async () => {
    const store = buildStore();
    const returned = await store.store({ key: 'k/x.pdf', bytes: Buffer.from('%PDF') });
    expect(returned).toBe('k/x.pdf');
  });
});
