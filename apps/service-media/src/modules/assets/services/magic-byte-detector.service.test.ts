import { describe, expect, it } from 'vitest';

import { MagicByteDetectorService } from './magic-byte-detector.service';

const detector = new MagicByteDetectorService();

function buildHead(prefix: number[], totalLen = 32): Buffer {
  const buf = Buffer.alloc(totalLen);
  for (let i = 0; i < prefix.length; i++) buf[i] = prefix[i]!;
  return buf;
}

describe('MagicByteDetectorService', () => {
  it('detects JPEG (FF D8 FF)', () => {
    expect(detector.detect(buildHead([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]))).toBe('image/jpeg');
  });

  it('detects PNG (89 50 4E 47 0D 0A 1A 0A)', () => {
    expect(
      detector.detect(buildHead([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00])),
    ).toBe('image/png');
  });

  it('detects WebP (RIFF{size}WEBP)', () => {
    const head = buildHead([
      0x52,
      0x49,
      0x46,
      0x46, // RIFF
      0x00,
      0x00,
      0x00,
      0x00, // size (don't care)
      0x57,
      0x45,
      0x42,
      0x50, // WEBP
    ]);
    expect(detector.detect(head)).toBe('image/webp');
  });

  it('detects AVIF (ftyp avif brand)', () => {
    const head = buildHead([
      0x00,
      0x00,
      0x00,
      0x18, // size
      0x66,
      0x74,
      0x79,
      0x70, // ftyp
      0x61,
      0x76,
      0x69,
      0x66, // avif
    ]);
    expect(detector.detect(head)).toBe('image/avif');
  });

  it('detects HEIC variants as AVIF (downstream Sharp converts)', () => {
    const head = buildHead([
      0x00,
      0x00,
      0x00,
      0x18,
      0x66,
      0x74,
      0x79,
      0x70,
      0x68,
      0x65,
      0x69,
      0x63, // heic
    ]);
    expect(detector.detect(head)).toBe('image/avif');
  });

  it('detects MP4 (ftyp isom brand)', () => {
    const head = buildHead([
      0x00,
      0x00,
      0x00,
      0x18,
      0x66,
      0x74,
      0x79,
      0x70,
      0x69,
      0x73,
      0x6f,
      0x6d, // isom
    ]);
    expect(detector.detect(head)).toBe('video/mp4');
  });

  it('detects MP4 (ftyp mp42 brand)', () => {
    const head = buildHead([
      0x00,
      0x00,
      0x00,
      0x18,
      0x66,
      0x74,
      0x79,
      0x70,
      0x6d,
      0x70,
      0x34,
      0x32, // mp42
    ]);
    expect(detector.detect(head)).toBe('video/mp4');
  });

  it('detects PDF (%PDF-)', () => {
    expect(detector.detect(buildHead([0x25, 0x50, 0x44, 0x46, 0x2d]))).toBe('application/pdf');
  });

  it('detects WebM (EBML 1A 45 DF A3)', () => {
    expect(detector.detect(buildHead([0x1a, 0x45, 0xdf, 0xa3]))).toBe('video/webm');
  });

  it('returns null for an unknown ftyp brand', () => {
    const head = buildHead([
      0x00,
      0x00,
      0x00,
      0x18,
      0x66,
      0x74,
      0x79,
      0x70,
      0x78,
      0x78,
      0x78,
      0x78, // xxxx — unknown
    ]);
    expect(detector.detect(head)).toBeNull();
  });

  it('returns null for arbitrary bytes', () => {
    const head = buildHead([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);
    expect(detector.detect(head)).toBeNull();
  });

  it('returns null for buffers shorter than 12 bytes', () => {
    expect(detector.detect(Buffer.from([0xff, 0xd8, 0xff]))).toBeNull();
  });

  it('does not mistake a near-PNG header for a real one', () => {
    const head = buildHead([0x89, 0x50, 0x4e, 0x46, 0x0d, 0x0a, 0x1a, 0x0a]); // last byte is N → F
    expect(detector.detect(head)).toBeNull();
  });
});
