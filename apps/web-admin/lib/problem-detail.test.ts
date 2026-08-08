import { describe, expect, it } from 'vitest';

import {
  PROBLEM_DETAIL_MAX_LENGTH,
  problemDetailParam,
  readDetailParam,
  readProblemDetail,
} from './problem-detail';

/**
 * Unit tests for the RFC 7807 detail sanitiser (TS-303c2b-followup-1;
 * the helper itself is TS-303c2b).
 *
 * This is the one piece of web-admin that takes text written by a
 * DOWNSTREAM SERVICE, puts it in a redirect URL, and renders it on a
 * page. Its safety properties are stated in its doc-block and were, until
 * now, unenforced by anything. Each is asserted here:
 *
 *   - control characters stripped, so nothing can smuggle a CR/LF into a
 *     redirect header;
 *   - length-capped, so a pathological body cannot blow the query string;
 *   - null (not `[object Object]`, not `""`) for anything that is not a
 *     usable detail string, so the caller falls back to its own copy;
 *   - the round-trip back off `searchParams` re-sanitises, because a
 *     query string is user-editable and is not trusted just because we
 *     put the value there.
 */

describe('readProblemDetail', () => {
  it('returns a plain detail unchanged', () => {
    expect(
      readProblemDetail({
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        detail: 'reviewer signoff must be performed by someone other than the case opener',
      }),
    ).toBe('reviewer signoff must be performed by someone other than the case opener');
  });

  it('STRIPS control characters — a CR/LF must never reach a redirect header', () => {
    const smuggled = 'blocked\r\nLocation: https://evil.example/';

    const cleaned = readProblemDetail({ detail: smuggled });

    expect(cleaned).toBe('blocked Location: https://evil.example/');
    expect(cleaned).not.toContain('\r');
    expect(cleaned).not.toContain('\n');
  });

  it('strips a NUL and a DEL, not just the common line breaks', () => {
    expect(readProblemDetail({ detail: 'a\u0000b\u007Fc' })).toBe('a b c');
  });

  it('collapses whitespace runs and trims', () => {
    expect(readProblemDetail({ detail: '   too    many   spaces   ' })).toBe('too many spaces');
  });

  it('caps an over-long detail and marks the truncation', () => {
    const long = 'x'.repeat(PROBLEM_DETAIL_MAX_LENGTH + 50);

    const cleaned = readProblemDetail({ detail: long });

    expect(cleaned).toHaveLength(PROBLEM_DETAIL_MAX_LENGTH);
    expect(cleaned?.endsWith('…')).toBe(true);
  });

  it('leaves a detail exactly at the cap untouched', () => {
    const exact = 'y'.repeat(PROBLEM_DETAIL_MAX_LENGTH);

    expect(readProblemDetail({ detail: exact })).toBe(exact);
  });

  it('returns null for a body that is not an object', () => {
    expect(readProblemDetail(null)).toBeNull();
    expect(readProblemDetail(undefined)).toBeNull();
    expect(readProblemDetail('a string body')).toBeNull();
    expect(readProblemDetail(42)).toBeNull();
  });

  it('returns null for an array body rather than indexing into it', () => {
    expect(readProblemDetail([{ detail: 'nope' }])).toBeNull();
  });

  it('returns null when detail is absent or not a string', () => {
    expect(readProblemDetail({ title: 'Conflict' })).toBeNull();
    expect(readProblemDetail({ detail: 409 })).toBeNull();
    expect(readProblemDetail({ detail: { nested: 'no' } })).toBeNull();
  });

  it('returns null when the detail sanitises down to nothing', () => {
    // A whitespace-only detail must fall back to the caller's generic
    // copy, not render as an empty explanation.
    expect(readProblemDetail({ detail: '   ' })).toBeNull();
    expect(readProblemDetail({ detail: '\r\n\t' })).toBeNull();
  });

  it('does not execute or unescape markup — it is text in, text out', () => {
    // React renders it as text; the sanitiser's job is only to keep it
    // one line and bounded, not to strip tags.
    expect(readProblemDetail({ detail: '<b>bold</b>' })).toBe('<b>bold</b>');
  });
});

describe('problemDetailParam', () => {
  it('builds an encoded query suffix', () => {
    expect(problemDetailParam({ detail: 'a b&c' })).toBe('&detail=a%20b%26c');
  });

  it('returns the empty string when there is nothing worth forwarding', () => {
    expect(problemDetailParam({ title: 'Conflict' })).toBe('');
    expect(problemDetailParam(null)).toBe('');
    expect(problemDetailParam({ detail: '  ' })).toBe('');
  });
});

describe('readDetailParam', () => {
  it('reads a forwarded detail back off searchParams', () => {
    expect(readDetailParam({ detail: 'kit for NY is not verified' })).toBe(
      'kit for NY is not verified',
    );
  });

  it('RE-SANITISES on the way back — the query string is user-editable', () => {
    expect(readDetailParam({ detail: 'tampered\r\nvalue' })).toBe('tampered value');
  });

  it('re-applies the length cap on the way back', () => {
    const long = 'z'.repeat(PROBLEM_DETAIL_MAX_LENGTH + 10);

    expect(readDetailParam({ detail: long })).toHaveLength(PROBLEM_DETAIL_MAX_LENGTH);
  });

  it('returns null for absent, undefined, or repeated params', () => {
    expect(readDetailParam(undefined)).toBeNull();
    expect(readDetailParam({})).toBeNull();
    // `?detail=a&detail=b` arrives as an array — not a usable detail.
    expect(readDetailParam({ detail: ['a', 'b'] })).toBeNull();
  });
});
