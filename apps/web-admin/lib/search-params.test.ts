import { describe, expect, it } from 'vitest';

import { readBanner, readEnum, readOffset, readString } from './search-params';

/**
 * Tests for the search-parameter readers extracted from 29 pages
 * (TS-303c2b-followup-1a).
 *
 * The property running through all of them: **a repeated or malformed
 * parameter is absent, never an error and never coerced.** These values
 * come off a URL an operator may have edited or had mangled by a mail
 * client, and a crash on the way into an admin console turns a cosmetic
 * mistake into a surface nobody can open.
 */

describe('readBanner', () => {
  it('reads the success banner', () => {
    expect(readBanner({ action: 'ok' })).toEqual({ kind: 'ok' });
  });

  it('reads an error banner with its code', () => {
    expect(readBanner({ action: 'err', code: 'not-found' })).toEqual({
      kind: 'err',
      code: 'not-found',
    });
  });

  it('an error with NO readable code still shows an error', () => {
    // Something failed and the operator must be told that much. Rendering
    // no banner would let a failed action look like a successful one.
    expect(readBanner({ action: 'err' })).toEqual({ kind: 'err', code: 'unknown' });
    expect(readBanner({ action: 'err', code: ['a', 'b'] })).toEqual({
      kind: 'err',
      code: 'unknown',
    });
  });

  it('is null when there is no action, an unknown action, or no params at all', () => {
    expect(readBanner(undefined)).toBeNull();
    expect(readBanner({})).toBeNull();
    expect(readBanner({ action: 'maybe' })).toBeNull();
    expect(readBanner({ action: ['ok', 'ok'] })).toBeNull();
  });

  it('ignores a success code — `ok` carries nothing', () => {
    expect(readBanner({ action: 'ok', code: 'ignored' })).toEqual({ kind: 'ok' });
  });
});

describe('readString', () => {
  it('reads a non-empty string', () => {
    expect(readString({ q: 'smith' }, 'q')).toBe('smith');
  });

  it('treats an EMPTY value as absent', () => {
    // `?q=` is what a cleared search box submits. "No filter" and "match
    // the empty string" must not diverge.
    expect(readString({ q: '' }, 'q')).toBeUndefined();
  });

  it('treats a repeated key as absent rather than picking one', () => {
    expect(readString({ q: ['a', 'b'] }, 'q')).toBeUndefined();
  });

  it('is undefined for a missing key or missing params', () => {
    expect(readString({}, 'q')).toBeUndefined();
    expect(readString(undefined, 'q')).toBeUndefined();
  });
});

describe('readEnum', () => {
  const allowed = new Set(['open', 'closed']);

  it('passes a value inside the allow-list', () => {
    expect(readEnum({ status: 'open' }, 'status', allowed)).toBe('open');
  });

  it('DROPS a value outside the allow-list', () => {
    // Forwarding an unknown filter either 400s the gateway or returns an
    // empty list that reads as "there is nothing here".
    expect(readEnum({ status: 'deleted' }, 'status', allowed)).toBeUndefined();
  });

  it('inherits readString: empty, repeated and missing are all absent', () => {
    expect(readEnum({ status: '' }, 'status', allowed)).toBeUndefined();
    expect(readEnum({ status: ['open', 'closed'] }, 'status', allowed)).toBeUndefined();
    expect(readEnum(undefined, 'status', allowed)).toBeUndefined();
  });

  it('an empty allow-list admits nothing', () => {
    expect(readEnum({ status: 'open' }, 'status', new Set())).toBeUndefined();
  });
});

describe('readOffset', () => {
  it('reads a valid offset', () => {
    expect(readOffset('40')).toBe(40);
  });

  it('defaults to the first page when absent or repeated', () => {
    expect(readOffset(undefined)).toBe(0);
    expect(readOffset(['0', '40'])).toBe(0);
  });

  it.each(['-1', 'abc', '', 'NaN', 'e5'])(
    'falls back to the first page on the malformed value %j',
    (value) => {
      expect(readOffset(value)).toBe(0);
    },
  );

  it('accepts zero explicitly', () => {
    expect(readOffset('0')).toBe(0);
  });

  it('prefix-parses rather than rejecting the screen', () => {
    // `Number.parseInt` stops at the first non-digit, so `40.9` is 40 and
    // `1.5e` is 1. That is fine here: the gateway is still the authority
    // on the value, and the page only has to stay openable.
    expect(readOffset('40.9')).toBe(40);
    expect(readOffset('1.5e')).toBe(1);
  });
});
