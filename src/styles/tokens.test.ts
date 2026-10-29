import { describe, expect, it } from 'vitest';
import css from './tokens.css?raw';

const tokens = new Map<string, [string, string]>();
for (const [, name, light, dark] of css.matchAll(
  /--([a-z-]+):\s*light-dark\((#[0-9a-f]{6}),\s*(#[0-9a-f]{6})\)/g,
)) {
  if (name && light && dark) tokens.set(name, [light, dark]);
}

/** WCAG 2.x relative luminance and contrast ratio. */
const luminance = (hex: string) => {
  const [r = 0, g = 0, b = 0] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

const backgrounds = ['bg', 'surface', 'surface-raised'];
// Every foreground/background pair the UI renders, with its WCAG AA minimum.
const pairs: [string, string, number][] = [
  ...backgrounds.flatMap((bg): [string, string, number][] => [
    ['text', bg, 4.5],
    ['text-muted', bg, 4.5],
    ['danger', bg, 4.5],
    ['warning', bg, 4.5],
    ['success', bg, 4.5],
    ['focus', bg, 3],
    ['border-strong', bg, 3],
  ]),
  // Selected file row: text and its warning flag on the subtle accent, plus the accent edge.
  ['text', 'accent-subtle', 4.5],
  ['warning', 'accent-subtle', 4.5],
  ['accent', 'accent-subtle', 3],
  ['focus', 'accent-subtle', 3],
];

// @req UX-003
describe('theme tokens', () => {
  it('define every semantic token from SPEC §5.4 for both modes', () => {
    for (const name of [
      'bg',
      'surface',
      'surface-raised',
      'text',
      'text-muted',
      'border',
      'accent',
      'danger',
      'warning',
      'success',
      'focus',
    ]) {
      expect(tokens.has(name), name).toBe(true);
    }
  });

  it.each(['light', 'dark'] as const)('meet WCAG AA contrast in %s mode', (mode) => {
    const index = mode === 'light' ? 0 : 1;
    const failures = pairs
      .map(([fg, bg, minimum]) => {
        const [fgColor, bgColor] = [tokens.get(fg)?.[index], tokens.get(bg)?.[index]];
        // A missing token is reported as a failure (ratio 0), never skipped.
        const ratio = fgColor && bgColor ? contrast(fgColor, bgColor) : 0;
        return { pair: `${fg} on ${bg}`, ratio: Number(ratio.toFixed(2)), minimum };
      })
      .filter(({ ratio, minimum }) => ratio < minimum);
    expect(failures).toEqual([]);
  });
});
