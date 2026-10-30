import { useDeferredValue, useMemo, useState } from 'react';
import { Button } from '../../components/atoms/Button';
import { IconButton } from '../../components/atoms/IconButton';
import { Select } from '../../components/atoms/Select';
import { TextField } from '../../components/atoms/TextField';
import { ErrorNotice } from '../../components/ErrorNotice';
import type { AppError, FileMetadata, TagEntry, Writability } from '../../lib/ipc';
import { GroupTree } from './GroupTree';
import { MetadataValueView } from './MetadataValueView';
import { filterTags, groupTree, sortTags, tagsAsText, valueText } from './tagFilter';
import type { GroupScope, Sort, SortKey } from './tagFilter';
import './MetadataInspector.css';

type Props = { file: FileMetadata | null; failure: AppError | null; reading: boolean };

/** Ctrl+F focuses this field (see app/shortcuts.ts). */
export const TAG_SEARCH_ID = 'tag-search';

const WRITABILITY: Record<Writability, { label: string; hint: string }> = {
  writable: { label: 'Writable', hint: 'The installed ExifTool can write this tag in this file.' },
  readOnly: {
    label: 'Read-only',
    hint: 'This tag or file format is not writable through the selected ExifTool version.',
  },
  unknown: { label: 'Unknown', hint: 'Write support could not be confirmed.' },
};
const SHOW_OPTIONS: { value: Writability | 'all'; label: string }[] = [
  { value: 'all', label: 'All tags' },
  { value: 'writable', label: 'Writable' },
  { value: 'readOnly', label: 'Read-only' },
  { value: 'unknown', label: 'Unknown' },
];
const COLUMNS: { key: SortKey; label: string }[] = [
  { key: 'group', label: 'Group' },
  { key: 'name', label: 'Tag' },
  { key: 'value', label: 'Value' },
];

/** Ascending → descending → ExifTool's own order. */
const nextSort = (sort: Sort, key: SortKey): Sort =>
  sort?.key !== key
    ? { key, descending: false }
    : sort.descending
      ? null
      : { key, descending: true };

/**
 * The selected file's tags (FR-006, UX-006): a group tree, search over `Group:Tag` and values,
 * a writability filter, sortable columns and copying. Labels stay format-neutral: tags are tags,
 * whatever the file is. Untrusted ExifTool output is only ever rendered as React text.
 *
 * Filters persist while moving between files, so the same tag can be compared across files; a
 * group the new file lacks falls back to all groups.
 */
export function MetadataInspector({ file, failure, reading }: Props) {
  const [text, setText] = useState('');
  const [scope, setScope] = useState<GroupScope>(null);
  const [writable, setWritable] = useState<Writability | 'all'>('all');
  const [sort, setSort] = useState<Sort>(null);
  const [copied, setCopied] = useState('');
  // Typing stays responsive on files with thousands of tags: filtering follows a beat behind.
  const query = useDeferredValue(text);

  const tree = useMemo(() => (file ? groupTree(file.tags) : []), [file]);
  const scoped = tree.some(
    (node) =>
      node.family === scope?.family &&
      (!scope.group || node.groups.some(({ group }) => group === scope.group)),
  )
    ? scope
    : null;
  const rows = useMemo(
    () =>
      file ? sortTags(filterTags(file.tags, { text: query, scope: scoped, writable }), sort) : [],
    [file, query, scoped?.family, scoped?.group, writable, sort], // eslint-disable-line react-hooks/exhaustive-deps
  );

  if (failure) return <ErrorNotice error={failure} />;
  if (!file) {
    return (
      <p className="muted">
        {reading
          ? 'Reading…'
          : 'Add a file (Ctrl+O) to inspect its metadata. Any format ExifTool recognizes works, not only photos.'}
      </p>
    );
  }

  const copy = async (content: string, what: string) => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(`Copied ${what}.`);
    } catch {
      setCopied(`Could not copy ${what}: the clipboard is not available.`);
    }
  };
  const filtered = query.trim() !== '' || scoped !== null || writable !== 'all';
  const clearFilters = () => {
    setText('');
    setScope(null);
    setWritable('all');
  };

  return (
    <div className="inspector">
      <h3 className="inspector-file" title={file.sourceFile}>
        {file.sourceFile}
      </h3>
      {file.unsupported ? (
        <p className="notice notice-neutral">
          Unsupported format: ExifTool does not recognize this file type, so only file system
          details are shown.
        </p>
      ) : (
        file.error && (
          <p role="alert" className="notice notice-error">
            ExifTool error: {file.error}
          </p>
        )
      )}
      {file.warnings.map((warning) => (
        <p key={warning} className="notice notice-warning">
          ExifTool warning: {warning}
        </p>
      ))}
      {!file.unsupported && file.formatWritable === false && (
        <p className="notice notice-neutral">
          This file format is not writable through the selected ExifTool version, so its tags are
          read-only apart from file system properties such as the file name and dates.
        </p>
      )}
      {!file.unsupported && file.formatWritable === null && (
        <p className="notice notice-neutral">
          Write support for this file could not be confirmed with the selected ExifTool version.
        </p>
      )}

      <div className="inspector-controls">
        <TextField
          id={TAG_SEARCH_ID}
          label="Find tags"
          type="search"
          placeholder="Group, tag or value"
          aria-keyshortcuts="Control+F"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <label className="inspector-show">
          <span>Show</span>
          <Select value={writable} options={SHOW_OPTIONS} onChange={setWritable} />
        </label>
        <Button
          disabled={rows.length === 0}
          onClick={() => void copy(tagsAsText(rows), `${rows.length} tags`)}
        >
          Copy visible
        </Button>
        <span className="muted inspector-count">
          {rows.length === file.tags.length
            ? `${file.tags.length.toLocaleString('en-US')} tags`
            : `${rows.length.toLocaleString('en-US')} of ${file.tags.length.toLocaleString('en-US')} tags`}
        </span>
        <span className="visually-hidden" role="status">
          {copied}
        </span>
      </div>

      <div className="inspector-body">
        <GroupTree tree={tree} total={file.tags.length} scope={scoped} onScope={setScope} />
        <div className="inspector-table">
          {rows.length === 0 ? (
            <p className="muted">
              {file.tags.length === 0
                ? 'ExifTool reported no tags for this file.'
                : 'No tags match these filters.'}{' '}
              {filtered && <Button onClick={clearFilters}>Clear filters</Button>}
            </p>
          ) : (
            <table className="tags">
              <caption className="visually-hidden">Tags of {file.sourceFile}</caption>
              <thead>
                <tr>
                  {COLUMNS.map(({ key, label }) => (
                    <th
                      key={key}
                      scope="col"
                      aria-sort={
                        sort?.key !== key ? undefined : sort.descending ? 'descending' : 'ascending'
                      }
                    >
                      <button
                        type="button"
                        className="tags-sort"
                        onClick={() => setSort((current) => nextSort(current, key))}
                      >
                        {label}
                        <span aria-hidden="true">
                          {sort?.key !== key ? '' : sort.descending ? ' ▼' : ' ▲'}
                        </span>
                      </button>
                    </th>
                  ))}
                  <th scope="col">Write</th>
                  <th scope="col">
                    <span className="visually-hidden">Copy</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((tag) => (
                  <TagRow key={tag.key} tag={tag} onCopy={copy} />
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

function TagRow({
  tag,
  onCopy,
}: {
  tag: TagEntry;
  onCopy: (content: string, what: string) => Promise<void>;
}) {
  const { label, hint } = WRITABILITY[tag.writable];
  return (
    <tr>
      <td className="tags-group">
        {tag.group1}
        {tag.copy !== null && ` · copy ${tag.copy}`}
      </td>
      {/* The row header names the tag fully, so same-name tags in other groups stay distinct. */}
      <th scope="row">
        <span className="visually-hidden">{tag.key.slice(0, -tag.name.length)}</span>
        {tag.name}
      </th>
      <td>
        <MetadataValueView value={tag.value} />
      </td>
      <td>
        <span className={`writability writability-${tag.writable}`} title={hint}>
          {label}
        </span>
      </td>
      <td>
        <IconButton
          icon="copy"
          label={`Copy value of ${tag.key}`}
          onClick={() => void onCopy(valueText(tag.value), `the value of ${tag.key}`)}
        />
      </td>
    </tr>
  );
}
