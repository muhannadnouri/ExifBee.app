#!/usr/bin/env node
// Builds the synthetic fixture corpus (SPEC §6.2) byte-for-byte from code, so every fixture and its
// metadata is ExifBee-authored (MIT) and generation is repeatable. Usage: [--check].
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';

export const FIXTURE_DIR = fileURLToPath(new URL('../tests/fixtures/', import.meta.url));
export const CHECKSUMS = 'SHA256SUMS';

// 1×1 mid-grey baseline JPEG (JFIF, no metadata), encoded once and kept as the pixel seed.
const SEED_JPEG = Buffer.from(
  'ffd8ffe000104a46494600010100000100010000ffdb004300100b0c0e0c0a100e0d0e1211101318281a181616183123' +
    '251d283a333d3c3933383740485c4e404457453738506d51575f626768673e4d71797064785c656763ffc0000b0800' +
    '01000101011100ffc40014000100000000000000000000000000000001ffc4001410010000000000000000000000000' +
    '0000000ffda0008010100003f001fffd9',
  'hex',
);

const UNICODE = 'مرحبا · 日本語 · 🐝';

const XMP = `<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:dc="http://purl.org/dc/elements/1.1/"
    xmlns:tiff="http://ns.adobe.com/tiff/1.0/"
    xmlns:Iptc4xmpCore="http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/">
   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${UNICODE}</rdf:li></rdf:Alt></dc:title>
   <dc:subject><rdf:Bag><rdf:li>bee</rdf:li><rdf:li>fixture</rdf:li></rdf:Bag></dc:subject>
   <tiff:Make>ExifBee XMP Make</tiff:Make>
   <Iptc4xmpCore:CreatorContactInfo rdf:parseType="Resource">
    <Iptc4xmpCore:CiAdrCity>Fixture City</Iptc4xmpCore:CiAdrCity>
   </Iptc4xmpCore:CreatorContactInfo>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
`;

const u16 = (n) => Buffer.from([n & 0xff, n >> 8]);
const u32 = (n) => Buffer.from([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, n >>> 24]);
const be32 = (n) => Buffer.from([n >>> 24, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);

/** Little-endian TIFF/EXIF block: IFD0 ASCII tags plus an Exif sub-IFD with DateTimeOriginal. */
function exif() {
  const ifd0 = [
    [0x010e, 'ExifBee synthetic JPEG'],
    [0x010f, 'ExifBee EXIF Make'],
    [0x013b, 'ExifBee Fixtures'],
  ];
  const exifIfd = [[0x9003, '2026:01:02 03:04:05']];
  const ifdSize = (count) => 2 + count * 12 + 4;
  const ifd0Offset = 8;
  const exifIfdOffset = ifd0Offset + ifdSize(ifd0.length + 1);
  let dataOffset = exifIfdOffset + ifdSize(exifIfd.length);
  const data = [];

  const ifd = (entries, extra = []) => {
    const parts = [u16(entries.length + extra.length)];
    for (const [tag, text] of entries) {
      const value = Buffer.from(`${text}\0`, 'latin1');
      parts.push(u16(tag), u16(2), u32(value.length), u32(dataOffset));
      data.push(value);
      dataOffset += value.length;
    }
    for (const entry of extra) parts.push(entry);
    parts.push(u32(0));
    return Buffer.concat(parts);
  };
  const exifPointer = Buffer.concat([u16(0x8769), u16(4), u32(1), u32(exifIfdOffset)]);
  const head = Buffer.concat([Buffer.from('II*\0'), u32(ifd0Offset)]);
  const blocks = [ifd(ifd0, [exifPointer]), ifd(exifIfd)];
  return Buffer.concat([head, ...blocks, ...data]);
}

const segment = (marker, payload) =>
  Buffer.concat([
    Buffer.from([0xff, marker]),
    Buffer.from([(payload.length + 2) >> 8, (payload.length + 2) & 0xff]),
    payload,
  ]);

function jpeg() {
  const app1Exif = segment(0xe1, Buffer.concat([Buffer.from('Exif\0\0'), exif()]));
  const app1Xmp = segment(0xe1, Buffer.from(`http://ns.adobe.com/xap/1.0/\0${XMP}`, 'utf8'));
  const comment = segment(0xfe, Buffer.from('ExifBee JPEG comment', 'latin1'));
  return Buffer.concat([
    SEED_JPEG.subarray(0, 2),
    app1Exif,
    app1Xmp,
    comment,
    SEED_JPEG.subarray(2),
  ]);
}

/** 1×1 PNG: `colorType` 0 (grey) or 3 (palette), one `pixel` byte, extra chunks before IDAT. */
function pngImage(colorType, pixel, chunks) {
  const chunk = (type, body) => {
    const typed = Buffer.concat([Buffer.from(type, 'latin1'), body]);
    return Buffer.concat([be32(body.length), typed, be32(crc32(typed))]);
  };
  // Filter byte 0 + the pixel, wrapped as an uncompressed (stored) zlib stream with Adler-32.
  const raw = Buffer.from([0x00, pixel]);
  let [low, high] = [1, 0];
  for (const byte of raw) {
    low = (low + byte) % 65521;
    high = (high + low) % 65521;
  }
  const idat = Buffer.concat([
    Buffer.from([0x78, 0x01, 0x01, 0x02, 0x00, 0xfd, 0xff]),
    raw,
    be32(((high << 16) | low) >>> 0),
  ]);
  const ihdr = Buffer.concat([be32(1), be32(1), Buffer.from([8, colorType, 0, 0, 0])]);
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', ihdr),
    ...chunks.map(([type, body]) => chunk(type, body)),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const png = () =>
  pngImage(0, 0x80, [
    ['tEXt', Buffer.from('Title\0ExifBee PNG title', 'latin1')],
    ['iTXt', Buffer.concat([Buffer.from('Description\0\0\0\0\0'), Buffer.from(UNICODE, 'utf8')])],
  ]);

/** A paletted PNG: ExifTool reports its PLTE chunk as binary data (`PNG:Palette`). */
const palettePng = () =>
  pngImage(3, 0x00, [
    ['PLTE', Buffer.from(Array.from({ length: 768 }, (_, i) => Math.floor(i / 3)))],
  ]);

/** Values a float or integer parser would corrupt: leading zeros, trailing zeros, exponents. */
const NUMBERS_XMP = `<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">
   <dc:identifier>007</dc:identifier>
   <dc:source>13.50</dc:source>
   <dc:format>1e3</dc:format>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
`;

function pdf() {
  const utf16 = (text) =>
    `<FEFF${Buffer.from(text, 'utf16le').swap16().toString('hex').toUpperCase()}>`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 72] >>',
    `<< /Title (ExifBee PDF title) /Author (ExifBee Fixtures) /Subject ${utf16(UNICODE)} /Keywords (bee, fixture) >>`,
  ];
  let body = '%PDF-1.4\n';
  const offsets = objects.map((object, index) => {
    const offset = body.length;
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 4 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

/** Single stored entry with a fixed 1980-01-01 timestamp, so the bytes never depend on the clock. */
function zip() {
  const name = Buffer.from('hello.txt');
  const content = Buffer.from('ExifBee archive member\n');
  const common = Buffer.concat([
    u16(20),
    u16(0),
    u16(0),
    u16(0),
    u16(0x21),
    u32(crc32(content)),
    u32(content.length),
    u32(content.length),
    u16(name.length),
    u16(0),
  ]);
  const local = Buffer.concat([u32(0x04034b50), common, name, content]);
  const central = Buffer.concat([
    u32(0x02014b50),
    u16(20),
    common,
    u16(0),
    u16(0),
    u16(0),
    u32(0),
    u32(0),
    name,
  ]);
  const end = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(1),
    u16(1),
    u32(central.length),
    u32(local.length),
    u16(0),
  ]);
  return Buffer.concat([local, central, end]);
}

/** Markup an attacker could plant in metadata; ExifTool returns it decoded (SEC-003, S1-T06). */
export const HOSTILE_TITLE =
  '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>';
export const HOSTILE_DESCRIPTION = '"><svg onload="window.__pwned=3"></svg>';

const xmlEscape = (text) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const HOSTILE_XMP = `<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">
   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${xmlEscape(HOSTILE_TITLE)}</rdf:li></rdf:Alt></dc:title>
   <dc:description><rdf:Alt><rdf:li xml:lang="x-default">${xmlEscape(HOSTILE_DESCRIPTION)}</rdf:li></rdf:Alt></dc:description>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
`;

/** @returns {{ name: string, bytes: Buffer }[]} the corpus, in a stable order */
export function fixtures() {
  const fullJpeg = jpeg();
  return [
    { name: 'metadata.jpg', bytes: fullJpeg },
    { name: 'metadata.png', bytes: png() },
    { name: 'metadata.pdf', bytes: pdf() },
    { name: 'sidecar.xmp', bytes: Buffer.from(XMP, 'utf8') },
    { name: 'archive.zip', bytes: zip() },
    { name: 'no-metadata.jpg', bytes: SEED_JPEG },
    { name: 'plain.txt', bytes: Buffer.from('ExifBee plain text with no embedded metadata\n') },
    { name: 'empty.bin', bytes: Buffer.alloc(0) },
    { name: 'truncated.jpg', bytes: fullJpeg.subarray(0, 64) },
    { name: 'hostile.xmp', bytes: Buffer.from(HOSTILE_XMP, 'utf8') },
    { name: 'palette.png', bytes: palettePng() },
    { name: 'numbers.xmp', bytes: Buffer.from(NUMBERS_XMP, 'utf8') },
  ];
}

/** sha256sum-compatible listing (`sha256sum -c SHA256SUMS` works in the fixture directory). */
export const checksums = (corpus) =>
  corpus
    .map(({ name, bytes }) => `${createHash('sha256').update(bytes).digest('hex')}  ${name}\n`)
    .join('');

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const corpus = fixtures();
  const expected = checksums(corpus);
  if (process.argv.includes('--check')) {
    const onDisk = checksums(
      corpus.map(({ name }) => ({ name, bytes: readFileSync(join(FIXTURE_DIR, name)) })),
    );
    const recorded = readFileSync(join(FIXTURE_DIR, CHECKSUMS), 'utf8');
    if (onDisk !== expected || recorded !== expected) {
      console.error(
        'fixtures: generated output differs from tests/fixtures; run `npm run fixtures`',
      );
      process.exit(1);
    }
    console.log('fixtures: OK');
  } else {
    for (const { name, bytes } of corpus) writeFileSync(join(FIXTURE_DIR, name), bytes);
    writeFileSync(join(FIXTURE_DIR, CHECKSUMS), expected);
    console.log(`fixtures: wrote ${corpus.length} files and ${CHECKSUMS}`);
  }
}
