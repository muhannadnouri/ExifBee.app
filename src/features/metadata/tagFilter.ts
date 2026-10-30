import type { MetadataValue, TagEntry, Writability } from '../../lib/ipc';

/** A value as one line of plain text: for search, sorting and the clipboard. */
export function valueText(value: MetadataValue): string {
  switch (value.kind) {
    case 'text':
      return value.text;
    case 'binary':
      return `(Binary data ${value.byteLength ?? 'of unknown size'} bytes)`;
    case 'list':
      return value.items.map(valueText).join(', ');
    case 'structure':
      return `{${value.fields.map((field) => `${field.name}=${valueText(field.value)}`).join(', ')}}`;
  }
}

/** Group family shown for a tag; tags ExifTool does not list fall under "Other". */
export const familyOf = (tag: TagEntry) => tag.group0 ?? 'Other';

export type GroupNode = {
  family: string;
  count: number;
  groups: { group: string; count: number }[];
};

/** Families (EXIF, XMP, File, …) with their specific groups (IFD0, XMP-dc, …), in first-seen order. */
export function groupTree(tags: TagEntry[]): GroupNode[] {
  const families = new Map<string, Map<string, number>>();
  for (const tag of tags) {
    const groups = families.get(familyOf(tag)) ?? new Map<string, number>();
    groups.set(tag.group1, (groups.get(tag.group1) ?? 0) + 1);
    families.set(familyOf(tag), groups);
  }
  return [...families].map(([family, groups]) => ({
    family,
    count: [...groups.values()].reduce((sum, count) => sum + count, 0),
    groups: [...groups].map(([group, count]) => ({ group, count })),
  }));
}

/** A tree selection: everything, one family, or one specific group within a family. */
export type GroupScope = { family: string; group?: string } | null;

export type TagQuery = {
  /** Matched case-insensitively against `Group:Tag` and the value text. */
  text: string;
  scope: GroupScope;
  writable: Writability | 'all';
};

export function filterTags(tags: TagEntry[], { text, scope, writable }: TagQuery): TagEntry[] {
  const needle = text.trim().toLowerCase();
  return tags.filter(
    (tag) =>
      (!scope ||
        (familyOf(tag) === scope.family && (!scope.group || tag.group1 === scope.group))) &&
      (writable === 'all' || tag.writable === writable) &&
      (!needle ||
        tag.key.toLowerCase().includes(needle) ||
        valueText(tag.value).toLowerCase().includes(needle)),
  );
}

export type SortKey = 'group' | 'name' | 'value';
export type Sort = { key: SortKey; descending: boolean } | null;

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const sortText: Record<SortKey, (tag: TagEntry) => string> = {
  group: (tag) => `${tag.group1}:${tag.copy ?? 0}:${tag.name}`,
  name: (tag) => `${tag.name}:${tag.group1}`,
  value: (tag) => valueText(tag.value),
};

/** `null` keeps ExifTool's own order; otherwise a stable, number-aware sort. */
export function sortTags(tags: TagEntry[], sort: Sort): TagEntry[] {
  if (!sort) return tags;
  const text = sortText[sort.key];
  const sorted = [...tags].sort((a, b) => collator.compare(text(a), text(b)));
  return sort.descending ? sorted.reverse() : sorted;
}

/** One `Group:Tag<Tab>value` line per tag, for pasting into a text file or spreadsheet. */
export const tagsAsText = (tags: TagEntry[]) =>
  tags.map((tag) => `${tag.key}\t${valueText(tag.value)}`).join('\n');
