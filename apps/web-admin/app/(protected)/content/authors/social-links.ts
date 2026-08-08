/**
 * Shared form → social-links helper for the author create/update actions
 * (TS-283). Lives outside the `'use server'` modules because a server-action
 * file may only export async server actions; this is a plain sync helper.
 */

/** Build a social-links object from the form, or null when every link is blank. */
export function buildSocialLinks(formData: FormData): Record<string, string> | null {
  const platforms = ['twitter', 'linkedin', 'github', 'website'] as const;
  const links: Record<string, string> = {};
  for (const platform of platforms) {
    const raw = formData.get(`social_${platform}`);
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (trimmed.length > 0) links[platform] = trimmed;
  }
  return Object.keys(links).length === 0 ? null : links;
}
