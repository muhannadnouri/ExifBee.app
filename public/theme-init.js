// Runs before first paint (classic script in <head>) so an explicit Light/Dark choice never shows
// the other theme first. Keep the key and values in sync with src/app/theme.ts.
try {
  const saved = localStorage.getItem('exifbee.theme');
  if (saved === 'light' || saved === 'dark') document.documentElement.dataset.theme = saved;
} catch {
  // Storage unavailable: System theme, which CSS already applies.
}
