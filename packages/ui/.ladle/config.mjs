/**
 * Ladle config for @taste-and-see/ui.
 *
 * - `addons.theme` is disabled (Ladle's built-in light/dark would conflict
 *   with our senior-mode hinge; the senior-mode toggle is provided as a
 *   custom global control via `.ladle/components.tsx`).
 * - `stories` glob picks up co-located `*.stories.tsx` files next to each
 *   primitive in `src/components/`.
 */
export default {
  stories: 'src/**/*.stories.{ts,tsx}',
  addons: {
    a11y: { enabled: true },
    action: { enabled: true },
    control: { enabled: true },
    msw: { enabled: false },
    theme: { enabled: false },
    mode: { enabled: false },
    rtl: { enabled: false },
    source: { enabled: true },
    width: {
      enabled: true,
      options: {
        mobile: 360,
        tablet: 768,
        desktop: 1280,
      },
    },
  },
};
