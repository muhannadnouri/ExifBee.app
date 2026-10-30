import { describe, expect, it } from 'vitest';
import { tagsOf } from '../../../tests/support/tags';
import { filterTags, groupTree, sortTags, tagsAsText, valueText } from './tagFilter';

const tags = tagsOf(
  {
    'IFD0:Make': 'Canon',
    'XMP-tiff:Copy1:Make': 'Canon (XMP)',
    'XMP-dc:Subject': ['bee', 'fixture'],
    'XMP-iptcCore:CreatorContactInfo': { CiAdrCity: 'Fixture City' },
    'Composite:ImageSize': '10x2',
    'PNG:Palette': { binary: 768 },
    'Odd:Thing': 'v9',
  },
  {
    'IFD0:Make': ['EXIF', 'writable'],
    'XMP-tiff:Copy1:Make': ['XMP', 'writable'],
    'XMP-dc:Subject': ['XMP', 'writable'],
    'XMP-iptcCore:CreatorContactInfo': ['XMP', 'writable'],
    'Composite:ImageSize': ['Composite', 'readOnly'],
    'PNG:Palette': ['PNG', 'readOnly'],
  },
);
const keys = (list: typeof tags) => list.map((tag) => tag.key);
const all = { text: '', scope: null, writable: 'all' } as const;

// @req FR-006, UX-006
describe('tag search, filters and sort', () => {
  it('turns every kind of value into one searchable, copyable line', () => {
    expect(tags.map((tag) => valueText(tag.value))).toEqual([
      'Canon',
      'Canon (XMP)',
      'bee, fixture',
      '{CiAdrCity=Fixture City}',
      '10x2',
      '(Binary data 768 bytes)',
      'v9',
    ]);
  });

  it('groups by family, then specific group, with counts; unlisted tags go under Other', () => {
    expect(groupTree(tags)).toEqual([
      { family: 'EXIF', count: 1, groups: [{ group: 'IFD0', count: 1 }] },
      {
        family: 'XMP',
        count: 3,
        groups: [
          { group: 'XMP-tiff', count: 1 },
          { group: 'XMP-dc', count: 1 },
          { group: 'XMP-iptcCore', count: 1 },
        ],
      },
      { family: 'Composite', count: 1, groups: [{ group: 'Composite', count: 1 }] },
      { family: 'PNG', count: 1, groups: [{ group: 'PNG', count: 1 }] },
      { family: 'Other', count: 1, groups: [{ group: 'Odd', count: 1 }] },
    ]);
  });

  it('finds text in group-qualified names and in values, case-insensitively', () => {
    // Same tag name in two groups: both found, still two entries.
    expect(keys(filterTags(tags, { ...all, text: 'MAKE' }))).toEqual([
      'IFD0:Make',
      'XMP-tiff:Copy1:Make',
    ]);
    expect(keys(filterTags(tags, { ...all, text: 'xmp-tiff:' }))).toEqual(['XMP-tiff:Copy1:Make']);
    // Inside a list and inside a structure.
    expect(keys(filterTags(tags, { ...all, text: 'fixture' }))).toEqual([
      'XMP-dc:Subject',
      'XMP-iptcCore:CreatorContactInfo',
    ]);
    expect(keys(filterTags(tags, { ...all, text: '  ' }))).toHaveLength(tags.length);
  });

  it('scopes by family or group and filters by writability, combined with search', () => {
    expect(keys(filterTags(tags, { ...all, scope: { family: 'XMP' } }))).toHaveLength(3);
    expect(keys(filterTags(tags, { ...all, scope: { family: 'XMP', group: 'XMP-dc' } }))).toEqual([
      'XMP-dc:Subject',
    ]);
    expect(keys(filterTags(tags, { ...all, writable: 'readOnly' }))).toEqual([
      'Composite:ImageSize',
      'PNG:Palette',
    ]);
    expect(keys(filterTags(tags, { ...all, writable: 'unknown' }))).toEqual(['Odd:Thing']);
    expect(
      keys(filterTags(tags, { text: 'canon', scope: { family: 'XMP' }, writable: 'writable' })),
    ).toEqual(['XMP-tiff:Copy1:Make']);
  });

  it('sorts by group, tag or value (numbers in order), and keeps ExifTool order without a sort', () => {
    const numbers = tagsOf({ 'A:N10': '10', 'A:N9': '9', 'B:N100': '100' });
    expect(keys(sortTags(numbers, { key: 'value', descending: false }))).toEqual([
      'A:N9',
      'A:N10',
      'B:N100',
    ]);
    expect(keys(sortTags(numbers, { key: 'name', descending: true }))).toEqual([
      'B:N100',
      'A:N10',
      'A:N9',
    ]);
    expect(keys(sortTags(tags, { key: 'group', descending: false })).slice(0, 2)).toEqual([
      'Composite:ImageSize',
      'IFD0:Make',
    ]);
    expect(sortTags(tags, null)).toBe(tags);
  });

  it('copies tags as Group:Tag and value lines', () => {
    expect(tagsAsText(tags.slice(0, 3))).toBe(
      'IFD0:Make\tCanon\nXMP-tiff:Copy1:Make\tCanon (XMP)\nXMP-dc:Subject\tbee, fixture',
    );
  });
});
