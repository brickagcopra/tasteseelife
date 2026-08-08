import { describe, expect, it } from 'vitest';

import { renderCertificatePdf } from './certificate-pdf';

const FACTS = {
  holderName: 'Jane Holder',
  courseTitle: 'Dementia-Sensitive Dining',
  track: 'dementia_sensitive' as const,
  issuedAt: '2026-06-08T12:00:00.000Z',
  expiresAt: '2028-06-08T12:00:00.000Z',
  verificationToken: 'tok_abc123',
  verificationUrl: 'https://app.example.com/verify/cert/tok_abc123',
};

describe('renderCertificatePdf', () => {
  it('renders a non-empty PDF buffer (magic-byte header)', async () => {
    const bytes = await renderCertificatePdf(FACTS);
    expect(Buffer.isBuffer(bytes)).toBe(true);
    expect(bytes.byteLength).toBeGreaterThan(500);
    // Every PDF starts with the `%PDF-` signature.
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    // …and ends with the EOF marker.
    expect(bytes.subarray(-6).toString('latin1')).toContain('%%EOF');
  });

  it('renders without an expiry (no "Valid through" segment)', async () => {
    const bytes = await renderCertificatePdf({ ...FACTS, expiresAt: null });
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(bytes.byteLength).toBeGreaterThan(500);
  });

  it('renders every specialty track label without throwing', async () => {
    for (const track of [
      'general',
      'dementia_sensitive',
      'therapeutic_meals',
      'luxury_in_home',
      'cultural_comfort_cuisine',
    ] as const) {
      const bytes = await renderCertificatePdf({ ...FACTS, track });
      expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    }
  });
});
