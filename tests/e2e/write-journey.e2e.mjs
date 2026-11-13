// The write journey on the built app (S4-T08): read → edit → review → apply → verify → backup →
// log, with WebKitGTK, Rust and the real ExifTool on temporary copies. Only the OS file picker
// is replaced (the `e2e` feature, DEC-027). Run through `npm run test:e2e:desktop:docker`.
// A failure leaves a screenshot in target-e2e/.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
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
import { launch, log, until } from './driver.mjs';

const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url));
const root = mkdtempSync(join(os.tmpdir(), 'exifbee-e2e-write-'));
const sum = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const place = (fixture, name) => {
  mkdirSync(files, { recursive: true });
  const path = join(files, name);
  copyFileSync(join(FIXTURES, fixture), path);
  return path;
};
/** One tag as ExifTool itself reads it from disk, outside the app. */
const onDisk = (path, tag) => {
  const [read] = JSON.parse(
    execFileSync('exiftool', ['-json', '-G1', `-${tag}`, '--', path], {
      encoding: 'utf8',
    }),
  );
  return read[tag];
};

// The golden fixtures must never change, whatever the app writes.
const golden = new Map(
  readdirSync(FIXTURES, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const path = join(entry.parentPath, entry.name);
      return [path.slice(FIXTURES.length), sum(path)];
    }),
);

const files = join(root, 'مرحبا files');
const photo = place('metadata.jpg', '-leading "quoted" photo.jpg');
const rejected = place('metadata.jpg', 'rejected.jpg');
const archive = place('archive.zip', 'archive.zip');
const locked = place('metadata.jpg', 'locked.jpg');
const empty = place('palette.png', 'empty.png');
const report = place('metadata.pdf', 'report.pdf');
chmodSync(locked, 0o444);
const picked = [photo, rejected, archive, locked, empty, report];
const original = new Map(picked.map((path) => [path, sum(path)]));
const name = (path) => path.split('/').pop();

const LIST = '[role="listbox"] [role="option"]';
const INSPECTOR = '.metadata-pane';
const DIALOG = 'dialog[open]';
const select = (path) => app.click(LIST, name(path));
const rowOf = (key) => `tr[data-key="${key}"]`;
/** Opens a drawer by its heading button if it is closed. */
const openDrawer = async (id) => {
  const open = await app.run(
    `return document.getElementById(arguments[0]).getAttribute('aria-expanded') === 'true';`,
    `${id}-toggle`,
  );
  if (!open) await app.click(`#${id}-toggle`);
};
/** Stages a new text value for `key` of the selected file. */
const stageText = async (key, value) => {
  await app.click('button', `Edit ${key}`);
  await app.text(DIALOG, (text) => text.includes(key));
  await app.type(`${DIALOG} textarea`, value);
  await stage('Stage change');
};
/** Clicks a dialog button once it is enabled (the editor checks the stored bytes first). */
const stage = async (label) => {
  await until(
    () =>
      app.run(
        `return [...document.querySelectorAll('dialog[open] button')]
           .some((button) => button.textContent === arguments[0] && !button.disabled);`,
        label,
      ),
    `${label} enabled`,
  );
  await app.click(`${DIALOG} button`, label);
};

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

// @req TST-002, TST-004, TST-007, FR-008, FR-010, FR-011, FR-014, FR-017, SEC-004, SEC-005
describe('write journey', () => {
  before(async () => {
    app = await launch(process.env.EXIFBEE_APP, {
      XDG_CONFIG_HOME: join(root, 'config'),
      XDG_CACHE_HOME: join(root, 'cache'),
      XDG_DATA_HOME: join(root, 'data'),
      EXIFBEE_E2E_PICK_FILES: picked.join('\n'),
    });
    await app.click('button[aria-haspopup="menu"]');
    await app.click('[role="menuitem"]', 'Files…');
    await app.text(LIST, (text) => picked.every((path) => text.includes(name(path))));
  });
  after(async () => {
    await app?.close();
    chmodSync(locked, 0o644);
    rmSync(root, { recursive: true, force: true });
  });

  steps('edits a hostile-named file in Unicode, applies with a backup and verifies', async () => {
    await select(photo);
    await app.text(rowOf('XMP-dc:Title'), (text) => text.includes('مرحبا'));
    await stageText('XMP-dc:Title', 'Abeille · مرحبا · ñ');
    await app.click('button', 'Edit IFD0:Artist');
    await app.click(`${DIALOG} button`, 'Delete tag');
    await openDrawer('actions-drawer');
    await app.click('button', 'Review changes…');
    await app.text(DIALOG, (text) => text.includes('1 file would change'));
    await app.text(
      DIALOG,
      (text) =>
        text.includes('XMP-dc:Title') &&
        text.includes('Abeille · مرحبا · ñ') &&
        text.includes('IFD0:Artist') &&
        text.includes(`Backup of the original: ${photo}_original`),
      'the readable diff and the backup',
    );
    await app.click(`${DIALOG} button`, 'Apply to 1 file');
    await app.text(DIALOG, (text) => text.includes('Changed and verified'));
    await app.click(`${DIALOG} button`, 'Done');

    // The app reads the file again, logs the outcome, and the disk agrees.
    await app.text(rowOf('XMP-dc:Title'), (text) => text.includes('Abeille · مرحبا · ñ'));
    await openDrawer('log-drawer');
    await app.text('[role="log"]', (text) =>
      text.includes(`Changed and verified ${photo}; backup: ${photo}_original`),
    );
    assert.equal(onDisk(photo, 'XMP-dc:Title'), 'Abeille · مرحبا · ñ');
    assert.equal(onDisk(photo, 'IFD0:Artist'), undefined);
    assert.equal(sum(`${photo}_original`), golden.get('metadata.jpg'));
  });

  steps('reports a write ExifTool rejects, and leaves the file as it was', async () => {
    await select(rejected);
    await app.text(rowOf('IFD0:Make'), Boolean);
    await stageText('ExifIFD:DateTimeOriginal', 'not a date');
    await app.click('button', 'Review changes…');
    await app.click(`${DIALOG} button`, 'Apply to 1 file');
    await app.text(
      DIALOG,
      (text) => text.includes('Failed, the file is as it was') && text.includes('exit status'),
      'a failed outcome with ExifTool’s reason',
    );
    await app.click(`${DIALOG} button`, 'Done');
    assert.equal(sum(rejected), original.get(rejected));
    assert.equal(existsSync(`${rejected}_original`), false);
    // A failed change stays staged, to fix or undo.
    await app.text('#actions-drawer', (text) => text.includes('rejected.jpg'));
    await app.click('button', 'Discard all');
  });

  steps('offers no change for an unsupported format or a file it may not change', async () => {
    await select(archive);
    await app.text(INSPECTOR, (text) => text.includes('This file format is not writable'));
    await app.click('button', 'Edit ZIP:ZipFileName');
    await app.text(DIALOG, (text) => text.includes('not writable through the selected ExifTool'));
    await app.click(`${DIALOG} button`, 'Cancel');

    await select(locked);
    await app.text(rowOf('IFD0:Make'), Boolean);
    await app.click('button', 'Edit IFD0:Make');
    await app.text(DIALOG, (text) =>
      text.includes('You do not have permission to change this file'),
    );
    await app.click(`${DIALOG} button`, 'Cancel');
    assert.equal(sum(archive), original.get(archive));
    assert.equal(sum(locked), original.get(locked));
  });

  steps('says there is nothing to remove instead of writing a no-op', async () => {
    await select(empty);
    await app.text(INSPECTOR, (text) => text.includes('PNG'));
    await app.click('.inspector-changes button', 'Remove');
    await app.click('[role="menuitem"]', 'Remove all metadata…');
    await app.text(DIALOG, (text) => text.includes('Nothing to remove'));
    const disabled = await app.run(
      `return [...document.querySelectorAll('dialog[open] button')]
         .find((button) => button.textContent.startsWith('Stage removal')).disabled;`,
    );
    assert.equal(disabled, true);
    await app.click(`${DIALOG} button`, 'Cancel');
    assert.equal(sum(empty), original.get(empty));
  });

  steps('writes nothing when the review is cancelled before applying', async () => {
    await select(report);
    await app.text(rowOf('PDF:Title'), Boolean);
    await stageText('PDF:Title', 'Never written');
    await app.click('button', 'Review changes…');
    await app.text(DIALOG, (text) => text.includes('1 file would change'));
    await app.click(`${DIALOG} button`, 'Cancel');
    assert.equal(sum(report), original.get(report));
    await app.text('#actions-drawer', (text) => text.includes('PDF:Title'));
    await app.click('button', 'Discard all');
    await app.text('#actions-drawer', (text) => text.includes('No staged changes'));
  });

  steps('changed only the file that was applied, and never a golden fixture', () => {
    for (const path of picked.filter((path) => path !== photo)) {
      assert.equal(sum(path), original.get(path), path);
    }
    assert.deepEqual(
      readdirSync(files).sort(),
      [...picked.map(name), `${name(photo)}_original`].sort(),
    );
    for (const [fixture, hash] of golden) assert.equal(sum(join(FIXTURES, fixture)), hash, fixture);
  });
});
