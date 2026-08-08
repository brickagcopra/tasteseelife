import { describe, expect, it } from 'vitest';

import { detectMime } from './content-inspector';

/** Build a 64-byte buffer beginning with `head`. */
function pad(head: number[]): Buffer {
  const b = Buffer.alloc(64);
  Buffer.from(head).copy(b);
  return b;
}

/** ISO-BMFF: 4-byte size + 'ftyp' + 4-char brand. */
function isoBmff(brand: string): Buffer {
  const b = Buffer.alloc(64);
  b.write('\x00\x00\x00\x20', 0, 'binary');
  b.write('ftyp', 4, 'ascii');
  b.write(brand, 8, 'ascii');
  return b;
}

describe('detectMime', () => {
  it('detects JPEG', () => {
    expect(detectMime(pad([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
  });

  it('detects PNG', () => {
    expect(detectMime(pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png');
  });

  it('detects PDF', () => {
    expect(detectMime(pad([0x25, 0x50, 0x44, 0x46, 0x2d]))).toBe('application/pdf');
  });

  it('detects WebP (RIFF…WEBP)', () => {
    const b = Buffer.alloc(64);
    b.write('RIFF', 0, 'ascii');
    b.write('WEBP', 8, 'ascii');
    expect(detectMime(b)).toBe('image/webp');
  });

  it('detects AVIF / HEIC brands as image/avif', () => {
    for (const brand of ['avif', 'mif1', 'heic', 'heix']) {
      expect(detectMime(isoBmff(brand))).toBe('image/avif');
    }
  });

  it('detects MP4 brands as video/mp4', () => {
    for (const brand of ['isom', 'mp42', 'avc1', 'dash']) {
      expect(detectMime(isoBmff(brand))).toBe('video/mp4');
    }
  });

  it('detects WebM (EBML header)', () => {
    expect(detectMime(pad([0x1a, 0x45, 0xdf, 0xa3]))).toBe('video/webm');
  });

  it('returns null for an unknown ISO-BMFF brand', () => {
    expect(detectMime(isoBmff('xxxx'))).toBeNull();
  });

  it('returns null for unrecognised bytes', () => {
    expect(detectMime(pad([0x00, 0x01, 0x02, 0x03]))).toBeNull();
  });

  it('returns null for a too-short head (< 12 bytes)', () => {
    expect(detectMime(Buffer.from([0xff, 0xd8, 0xff]))).toBeNull();
  });
});
