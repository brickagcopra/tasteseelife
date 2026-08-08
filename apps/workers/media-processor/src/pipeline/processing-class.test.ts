import { describe, expect, it } from 'vitest';

import {
  isMimeAllowedForKind,
  PROCESSING_CLASS_MIMES,
  resolveProcessingClass,
} from './processing-class';

describe('resolveProcessingClass', () => {
  it('maps image MIMEs to image', () => {
    for (const mime of PROCESSING_CLASS_MIMES.image) {
      expect(resolveProcessingClass(mime)).toBe('image');
    }
  });

  it('maps video MIMEs to video', () => {
    for (const mime of PROCESSING_CLASS_MIMES.video) {
      expect(resolveProcessingClass(mime)).toBe('video');
    }
  });

  it('maps application/pdf to document', () => {
    expect(resolveProcessingClass('application/pdf')).toBe('document');
  });

  it('returns null for an unknown MIME', () => {
    expect(resolveProcessingClass('application/zip')).toBeNull();
  });
});

describe('isMimeAllowedForKind', () => {
  it('accepts video for provider_video_intro', () => {
    expect(isMimeAllowedForKind('provider_video_intro', 'video/mp4')).toBe(true);
    expect(isMimeAllowedForKind('provider_video_intro', 'video/webm')).toBe(true);
  });

  it('rejects an image masquerading as a provider_video_intro', () => {
    expect(isMimeAllowedForKind('provider_video_intro', 'image/jpeg')).toBe(false);
  });

  it('rejects a video uploaded as a senior_photo (kind/MIME mismatch)', () => {
    expect(isMimeAllowedForKind('senior_photo', 'video/mp4')).toBe(false);
    expect(isMimeAllowedForKind('senior_photo', 'image/jpeg')).toBe(true);
  });

  it('accepts both image and pdf for certification_evidence', () => {
    expect(isMimeAllowedForKind('certification_evidence', 'image/png')).toBe(true);
    expect(isMimeAllowedForKind('certification_evidence', 'application/pdf')).toBe(true);
    expect(isMimeAllowedForKind('certification_evidence', 'video/mp4')).toBe(false);
  });

  it('restricts provider_document to pdf only', () => {
    expect(isMimeAllowedForKind('provider_document', 'application/pdf')).toBe(true);
    expect(isMimeAllowedForKind('provider_document', 'image/jpeg')).toBe(false);
  });
});
