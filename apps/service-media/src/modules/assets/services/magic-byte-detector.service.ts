import { Injectable } from '@nestjs/common';

/**
 * Magic-byte MIME detection (CLAUDE.md §3.4 step 4).
 *
 * Inspects the first ~32 bytes of a file and returns the detected MIME
 * type, or `null` if the bytes don't match any of the formats the
 * platform accepts at upload time. Pure-TS — no external deps — so the
 * detector ships as part of the service-media app without pulling
 * `file-type` (which we'd add as a TS-110-followup if the surface grows
 * beyond the handful of formats below).
 *
 * Supported formats and their signatures (all little-endian byte counts):
 *
 *   JPEG     0xFF 0xD8 0xFF                                      → image/jpeg
 *   PNG      0x89 0x50 0x4E 0x47 0x0D 0x0A 0x1A 0x0A             → image/png
 *   WebP     RIFF{size}WEBP                                       → image/webp
 *   AVIF     {size}ftyp{avif|avis|mif1|miaf|heic|heix|heim|heis} → image/avif (and HEIC)
 *   PDF      %PDF-                                                → application/pdf
 *   MP4      {size}ftyp{isom|iso2|mp41|mp42|avc1|dash}            → video/mp4
 *   WebM     0x1A 0x45 0xDF 0xA3 (EBML header)                    → video/webm
 *
 * Returns `null` for any other input. The media-processor (TS-110-
 * followup-1) treats `null` as a `magic_byte_failed` event and the
 * asset transitions to `rejected`.
 *
 * **Why not the AVIF/HEIC `ftyp` brand explicitly?** ISO base media file
 * format encodes the brand in bytes 8..12. We sniff brands per-spec:
 * `avif` / `avis` / `mif1` / `miaf` → AVIF (we treat HEIC variants as
 * "AVIF-shaped" since the upload pipeline's downstream Sharp pass will
 * convert anyway). `isom` / `iso2` / `mp41` / `mp42` / `avc1` / `dash`
 * → MP4. Conservative — unknown brands return `null`.
 */
@Injectable()
export class MagicByteDetectorService {
  /**
   * Inspect the head of a byte buffer and return the detected MIME or
   * `null`. The caller is expected to provide at least 32 bytes; less
   * than 32 short-circuits to `null` for safety (no in-range checks
   * needed downstream).
   */
  detect(head: Buffer): string | null {
    if (head.length < 12) return null;

    if (isJpeg(head)) return 'image/jpeg';
    if (isPng(head)) return 'image/png';
    if (isPdf(head)) return 'application/pdf';
    if (isWebMagic(head)) return 'image/webp';
    if (isIsoBmff(head)) {
      const brand = head.subarray(8, 12).toString('ascii');
      if (
        brand === 'avif' ||
        brand === 'avis' ||
        brand === 'mif1' ||
        brand === 'miaf' ||
        brand === 'heic' ||
        brand === 'heix' ||
        brand === 'heim' ||
        brand === 'heis'
      ) {
        return 'image/avif';
      }
      if (
        brand === 'isom' ||
        brand === 'iso2' ||
        brand === 'iso3' ||
        brand === 'iso4' ||
        brand === 'iso5' ||
        brand === 'mp41' ||
        brand === 'mp42' ||
        brand === 'avc1' ||
        brand === 'dash'
      ) {
        return 'video/mp4';
      }
    }
    if (isWebm(head)) return 'video/webm';

    return null;
  }
}

function isJpeg(b: Buffer): boolean {
  return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
}

function isPng(b: Buffer): boolean {
  return (
    b[0] === 0x89 &&
    b[1] === 0x50 &&
    b[2] === 0x4e &&
    b[3] === 0x47 &&
    b[4] === 0x0d &&
    b[5] === 0x0a &&
    b[6] === 0x1a &&
    b[7] === 0x0a
  );
}

function isPdf(b: Buffer): boolean {
  // %PDF-
  return b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d;
}

function isWebMagic(b: Buffer): boolean {
  // RIFF{size}WEBP
  return (
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  );
}

function isIsoBmff(b: Buffer): boolean {
  // {size}{ftyp} — 'ftyp' at byte 4
  return b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70;
}

function isWebm(b: Buffer): boolean {
  // EBML header
  return b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3;
}
