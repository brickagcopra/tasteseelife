/**
 * Local Tailwind config consumed by Ladle's Vite pipeline so the primitives'
 * Tailwind classes resolve during preview. Production apps consume the
 * preset directly via `presets: [require('@taste-and-see/ui/tailwind-preset')]`.
 */
const preset = require('./tailwind.preset.cjs');

/** @type {import('tailwindcss').Config} */
module.exports = {
  presets: [preset],
  content: ['./src/**/*.{ts,tsx}', './.ladle/**/*.{ts,tsx}'],
};
