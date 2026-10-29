import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CHECKSUMS, FIXTURE_DIR, checksums, fixtures } from './generate-fixtures.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

// @req OPS-003
describe('fixture generator', () => {
  it('is repeatable and matches the committed corpus and checksums', () => {
    expect(checksums(fixtures())).toBe(checksums(fixtures()));
    const script = fileURLToPath(new URL('./generate-fixtures.mjs', import.meta.url));
    const run = spawnSync(process.execPath, [script, '--check'], { encoding: 'utf8' });
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
  });
});

// @req OPS-003, PKG-004
describe('legal audit', () => {
  // Tracked plus untracked-but-not-ignored files, so the audit also catches files before commit.
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);

  it('contains no ExifTool or Perl distribution files', () => {
    const forbidden =
      /(^|\/)exiftool(\(-k\))?(\.exe)?$|(^|\/)exiftool_files\/|(^|\/)Image\/ExifTool|\.(exe|dll|pm|pl|so|dylib)$/i;
    expect(files.filter((file) => forbidden.test(file))).toEqual([]);
  });

  it('contains only generated media, so no user photos or copyrighted samples', () => {
    const generated = new Set(
      read(`tests/fixtures/${CHECKSUMS}`)
        .split('\n')
        .filter(Boolean)
        .map((line) => `tests/fixtures/${line.split('  ')[1]}`),
    );
    const media =
      /\.(jpe?g|png|gif|webp|tiff?|heic|avif|bmp|dng|cr[23w]|nef|arw|orf|raf|rw2|mp4|mov|m4v|avi|mkv|mp3|m4a|flac|wav|ogg|pdf|zip|7z|rar|psd|svg|ico|icns)$/i;
    const stray = files.filter(
      (file) => media.test(file) && !generated.has(file) && !file.startsWith('src-tauri/icons/'),
    );
    expect(stray).toEqual([]);
    expect(FIXTURE_DIR.startsWith(root)).toBe(true);
  });

  it('ships the MIT license and a notice that keeps ExifTool under its own terms', () => {
    expect(read('LICENSE')).toMatch(/^MIT License/);
    const notices = read('THIRD_PARTY_NOTICES');
    expect(notices).toMatch(/ExifTool by Phil Harvey/);
    expect(notices).toMatch(/same terms as Perl/);
    expect(notices).toMatch(/OPEN until S8-T05/);
  });
});
