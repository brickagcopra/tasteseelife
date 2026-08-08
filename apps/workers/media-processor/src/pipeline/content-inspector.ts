/**
 * Magic-byte MIME detection (CLAUDE.md §3.4 step 4 / §17.16 — never trust
 * the client-declared Content-Type or extension).
 *
 * Pure-TS, no external deps. **This is a deliberate local mirror of
 * service-media's `MagicByteDetectorService`** — the worker is a separate
 * deployable and must not import another service's modules (CLAUDE.md
 * §2.3). The two copies are security-critical and must not drift;
 * extracting them to a shared `@taste-and-see/media-core` package is
 * carved as TS-201-followup-5 (the same "local mirror + dedupe follow-up"
 * idiom used for the Prisma row-type mirrors across the codebase).
 *
 * Supported signatures (little-endian byte counts):
 *
 *   JPEG     0xFF 0xD8 0xFF                                      → image/jpeg
 *   PNG      0x89 0x50 0x4E 0x47 0x0D 0x0A 0x1A 0x0A             → image/png
 *   WebP     RIFF{size}WEBP                                      → image/webp
 *   AVIF     {size}ftyp{avif|avis|mif1|miaf|heic|heix|heim|heis} → image/avif (and HEIC)
 *   PDF      %PDF-                                               → application/pdf
 *   MP4      {size}ftyp{isom|iso2|…|mp41|mp42|avc1|dash}         → video/mp4
 *   WebM     0x1A 0x45 0xDF 0xA3 (EBML header)                   → video/webm
 *
 * Returns `null` for anything else → the orchestrator emits
 * `magic_byte_failed` and the asset transitions to `rejected`.
 */
export function detectMime(head: Buffer): string | null {
  if (head.length < 12) return null;

  if (isJpeg(head)) return 'image/jpeg';
  if (isPng(head)) return 'image/png';
  if (isPdf(head)) return 'application/pdf';
  if (isWebp(head)) return 'image/webp';
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

function isWebp(b: Buffer): boolean {
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
