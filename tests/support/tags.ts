import type { MetadataValue, TagEntry } from '../../src/lib/ipc';

type Plain = string | Plain[] | { [field: string]: Plain } | { binary: number };

const valueOf = (plain: Plain): MetadataValue => {
  if (typeof plain === 'string') return { kind: 'text', text: plain };
  if (Array.isArray(plain)) return { kind: 'list', items: plain.map(valueOf) };
  if ('binary' in plain && typeof plain.binary === 'number') {
    return { kind: 'binary', byteLength: plain.binary };
  }
  return {
    kind: 'structure',
    fields: Object.entries(plain as Record<string, Plain>).map(([name, value]) => ({
      name,
      value: valueOf(value),
    })),
  };
};

/** Test helper: `{ 'XMP-tiff:Copy1:Make': 'Canon' }` → typed `TagEntry[]` as Rust sends them. */
export const tagsOf = (tags: Record<string, Plain>): TagEntry[] =>
  Object.entries(tags).map(([key, plain]) => {
    const parts = key.split(':');
    const [group1 = '', copy, name = ''] =
      parts.length === 3 ? parts : [parts[0], undefined, parts[1]];
    return {
      key,
      group1,
      copy: copy ? Number(copy.replace('Copy', '')) : null,
      name,
      value: valueOf(plain),
    };
  });
