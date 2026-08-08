import {
  MEDIA_MAX_IMAGE_SIZE_BYTES,
  MEDIA_MAX_PDF_SIZE_BYTES,
  MEDIA_MAX_VIDEO_SIZE_BYTES,
  type MediaAssetKind,
} from '@taste-and-see/contracts';
import { describe, expect, it } from 'vitest';

import { KIND_POLICIES, getKindPolicy } from './kind-policy';

describe('getKindPolicy', () => {
  it('caps image kinds at the image size limit + IANA image MIMEs', () => {
    const photo = getKindPolicy('senior_photo');
    expect(photo.maxBytes).toBe(MEDIA_MAX_IMAGE_SIZE_BYTES);
    expect(photo.allowedMimes).toEqual(['image/jpeg', 'image/png', 'image/webp', 'image/avif']);
  });

  it('caps the provider video intro at the video size limit + video MIMEs', () => {
    const video = getKindPolicy('provider_video_intro');
    expect(video.maxBytes).toBe(MEDIA_MAX_VIDEO_SIZE_BYTES);
    expect(video.allowedMimes).toEqual(['video/mp4', 'video/webm']);
  });

  it('restricts provider_document to PDF only at the PDF cap', () => {
    const doc = getKindPolicy('provider_document');
    expect(doc.maxBytes).toBe(MEDIA_MAX_PDF_SIZE_BYTES);
    expect(doc.allowedMimes).toEqual(['application/pdf']);
  });

  it('allows PDF or image for certification_evidence', () => {
    const cert = getKindPolicy('certification_evidence');
    expect(cert.allowedMimes).toContain('application/pdf');
    expect(cert.allowedMimes).toContain('image/jpeg');
  });

  it('allows PDF or image for academy_lesson_attachment', () => {
    const lesson = getKindPolicy('academy_lesson_attachment');
    expect(lesson.allowedMimes).toContain('application/pdf');
    expect(lesson.allowedMimes).toContain('image/jpeg');
  });

  it('memory_recipe_image is an image kind', () => {
    const recipe = getKindPolicy('memory_recipe_image');
    expect(recipe.maxBytes).toBe(MEDIA_MAX_IMAGE_SIZE_BYTES);
    expect(recipe.allowedMimes).toContain('image/webp');
    expect(recipe.allowedMimes).not.toContain('application/pdf');
  });

  it('provider_profile_photo is an image kind', () => {
    const profile = getKindPolicy('provider_profile_photo');
    expect(profile.maxBytes).toBe(MEDIA_MAX_IMAGE_SIZE_BYTES);
    expect(profile.allowedMimes).toContain('image/png');
  });
});

describe('KIND_POLICIES', () => {
  it('covers every MediaAssetKind exactly once (compile-time guarantee, runtime double-check)', () => {
    const known: readonly MediaAssetKind[] = [
      'senior_photo',
      'provider_profile_photo',
      'provider_video_intro',
      'memory_recipe_image',
      'provider_document',
      'certification_evidence',
      'academy_lesson_attachment',
    ];
    for (const k of known) {
      expect(KIND_POLICIES[k]).toBeDefined();
    }
  });
});
