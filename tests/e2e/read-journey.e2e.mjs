// The read journey on the built app (S3-T07): WebKitGTK, Rust and real ExifTool, under the real
// CSP. Only the OS file picker is replaced (the `e2e` feature, DEC-027). Run through
// `npm run test:e2e:desktop:docker`. A failure leaves a screenshot in target-e2e/.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { launch, log } from './driver.mjs';

const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url));
const root = mkdtempSync(join(os.tmpdir(), 'exifbee-e2e-'));
const sum = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const place = (folder, fixture, name) => {
  mkdirSync(folder, { recursive: true });
  const path = join(folder, name);
  copyFileSync(join(FIXTURES, fixture), path);
  return path;
};

const files = join(root, 'مرحبا files');
const picked = [
  place(files, 'metadata.jpg', '-leading "quoted" photo.jpg'),
  place(files, 'metadata.pdf', 'report.pdf'),
  place(files, 'movie.mp4', 'clip.mp4'),
  place(files, 'archive.zip', 'archive.zip'),
  place(files, 'unknown.dat', 'mystery'),
  place(files, 'empty.bin', 'empty.bin'),
];
const folder = join(root, 'folder');
const inFolder = [
  place(folder, 'metadata.png', 'a.png'),
  place(join(folder, 'sub'), 'sidecar.xmp', 'b.xmp'),
  place(folder, 'plain.txt', '.hidden.txt'),
];
const original = new Map([...picked, ...inFolder].map((path) => [path, sum(path)]));
const name = (path) => path.split('/').pop();

const LIST = '[role="listbox"] [role="option"]';
const INSPECTOR = '.metadata-pane';
const FILES_PANE = '.files-pane';
const select = (path) => app.click(LIST, name(path));
const rowOf = (key) => `tr[data-key="${key}"]`;

let app;
const steps = (title, test) =>
  it(title, async () => {
    log(title);
    try {
      await test();
    } catch (error) {
      mkdirSync('target-e2e', { recursive: true });
      const file = `target-e2e/failed-${title.replace(/\W+/g, '-')}.png`;
      writeFileSync(file, Buffer.from(await app.screenshot(), 'base64'));
      throw error;
    }
  });

// @req TST-004, FR-003, FR-004, FR-005, FR-006, FR-007, UX-006
describe('read journey', () => {
  before(async () => {
    app = await launch(process.env.EXIFBEE_APP, {
      XDG_CONFIG_HOME: join(root, 'config'),
      XDG_CACHE_HOME: join(root, 'cache'),
      XDG_DATA_HOME: join(root, 'data'),
      EXIFBEE_E2E_PICK_FILES: picked.join('\n'),
      EXIFBEE_E2E_PICK_FOLDER: folder,
    });
  });
  after(async () => {
    await app?.close();
    rmSync(root, { recursive: true, force: true });
  });

  steps('starts empty and says what to do', async () => {
    await app.text(FILES_PANE, (text) => text.includes('No files yet'));
    await app.text(INSPECTOR, (text) => text.includes('Ctrl+O'));
  });

  steps('adds mixed formats with hostile names and flags what cannot be read', async () => {
    await app.click('button[aria-haspopup="menu"]');
    await app.click('[role="menuitem"]', 'Files…');
    await app.text(LIST, (text) => picked.every((path) => text.includes(name(path))));
    await app.text(
      FILES_PANE,
      (text) => text.includes('6 files') && text.includes('1 unsupported'),
    );
    await app.text(LIST, (text) => text.includes('mystery (unsupported)'));
    await app.text(LIST, (text) => text.includes('empty.bin (error)'));
  });

  steps('shows a JPEG by group, with duplicate names apart and writability', async () => {
    await select(picked[0]);
    await app.text(
      `${INSPECTOR} h3`,
      (text) => text === picked[0],
      'the path with its hostile name',
    );
    await app.text(
      rowOf('IFD0:Make'),
      (text) => text.includes('ExifBee EXIF Make') && text.includes('Writable'),
    );
    await app.text(
      rowOf('XMP-tiff:Copy1:Make'),
      (text) => text.includes('copy 1') && text.includes('ExifBee XMP Make'),
    );
    await app.text(rowOf('Composite:ImageSize'), (text) => text.includes('Read-only'));
    await app.text(rowOf('XMP-dc:Title'), (text) => text.includes('مرحبا · 日本語 · 🐝'));
  });

  steps('inspects non-image formats, read-only and unsupported files truthfully', async () => {
    await select(picked[1]);
    await app.text(
      rowOf('PDF:Title'),
      (text) => text.includes('ExifBee PDF title') && text.includes('Writable'),
    );
    await select(picked[2]);
    await app.text(rowOf('QuickTime:Duration'), (text) => text.includes('Read-only'));
    await select(picked[3]);
    await app.text(INSPECTOR, (text) => text.includes('This file format is not writable'));
    await app.text(
      rowOf('ZIP:ZipFileName'),
      (text) => text.includes('hello.txt') && text.includes('Read-only'),
    );
    await app.text(rowOf('System:FileName'), (text) => text.includes('Writable'));
    await select(picked[4]);
    await app.text(INSPECTOR, (text) => text.includes('Unsupported format'));
    await select(picked[5]);
    await app.text(INSPECTOR, (text) => text.includes('ExifTool error: File is empty'));
  });

  steps('finds and filters tags', async () => {
    await select(picked[0]);
    await app.text(rowOf('IFD0:Make'), Boolean);
    await app.type('#tag-search', ':make');
    const same = (want) => (keys) => keys.join() === want.join();
    await app.rows(same(['IFD0:Make', 'XMP-tiff:Copy1:Make']), 'both Make tags only');
    await app.type('#tag-search', 'bee, fixture');
    await app.rows(same(['XMP-dc:Subject']), 'a value inside a list');
    await app.type('#tag-search', 'no such tag anywhere');
    await app.text(INSPECTOR, (text) => text.includes('No tags match these filters'));
    await app.click('button', 'Clear filters');
    await app.click('.group-tree-entry', 'XMP-dc');
    await app.rows(
      (keys) => keys.length === 2 && keys.every((key) => key.startsWith('XMP-dc:')),
      'only the XMP-dc group',
    );
    await app.click('.group-tree-entry', 'All groups');
  });

  steps('adds a folder with its options and reports the result', async () => {
    await app.click('button[aria-haspopup="menu"]');
    await app.click('[role="menuitem"]', 'Folder…');
    await app.text('dialog[open]', (text) => text.includes(folder));
    await app.click('dialog[open] button[type="submit"]');
    await app.text(LIST, (text) => text.includes('a.png') && text.includes('b.xmp'));
    await app.text(FILES_PANE, (text) => text.includes('8 files'));
    // Hidden files are off by default.
    const list = await app.text(FILES_PANE, Boolean);
    assert.ok(!list.includes('.hidden.txt'));
  });

  steps('fits a 1280×800 screen at 200% (a 640×400 window)', async () => {
    await app.setSize(640, 400);
    await app.text('html', Boolean);
    const fit = await app.run(`
      const fits = (node) => { const box = node.getBoundingClientRect(); return box.right <= innerWidth && box.left >= 0; };
      return { width: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth,
        controls: [...document.querySelectorAll('.toolbar button')].every(fits) };`);
    // The resize must really have happened, or the checks below prove nothing.
    assert.ok(fit.width <= 640, `window is ${fit.width} px wide, not 640`);
    assert.equal(fit.overflow, false, JSON.stringify(fit));
    assert.equal(fit.controls, true, JSON.stringify(fit));
  });

  steps('changed nothing on disk', () => {
    for (const [path, hash] of original) assert.equal(sum(path), hash, path);
    assert.equal(readdirSync(files).length, picked.length);
  });
});
