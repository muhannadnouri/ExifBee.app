import { memo, useCallback, useDeferredValue, useMemo, useState } from 'react';
import { Button } from '../../components/atoms/Button';
import { Select } from '../../components/atoms/Select';
import { TextField } from '../../components/atoms/TextField';
import { ErrorNotice } from '../../components/ErrorNotice';
import { MenuButton } from '../../components/MenuButton';
import type { AppError, FileMetadata, TagEntry, Writability } from '../../lib/ipc';
import { GroupTree } from './GroupTree';
import { filterTags, groupTree, sortTags, tagsAsText } from './tagFilter';
import { TagRows } from './TagRows';
import type { GroupScope, Sort, SortKey } from './tagFilter';
import './MetadataInspector.css';

type Props = {
  file: FileMetadata | null;
  failure: AppError | null;
  reading: boolean;
  /** Edit a tag, or `null` to add one; must be stable (the inspector is memoized). */
  onEdit: (tag: TagEntry | null) => void;
  /** Remove a group (`IFD0`, `XMP`) or `All` metadata; must be stable like `onEdit`. */
  onRemove: (group: string) => void;
  /** Copy to other files: the rows shown now and the tree's group; must be stable too. */
  onCopy: (shown: TagEntry[], group: string | undefined) => void;
  /** `Group:Tag` of this file's staged changes; must keep its identity between unrelated renders. */
  staged: Set<string>;
};

/** Ctrl+F focuses this field (see app/shortcuts.ts). */
export const TAG_SEARCH_ID = 'tag-search';

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
 *
 * Memoized: its props change only when the selection or its read does, so progress updates
 * elsewhere in the app (several a second during a scan) do not redraw thousands of tags.
 */
export const MetadataInspector = memo(function MetadataInspector({
  file,
  failure,
  reading,
  onEdit,
  onRemove,
  onCopy,
  staged,
}: Props) {
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

  const copy = useCallback((content: string, what: string) => {
    void navigator.clipboard.writeText(content).then(
      () => setCopied(`Copied ${what}.`),
      () => setCopied(`Could not copy ${what}: the clipboard is not available.`),
    );
  }, []);

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

  const filtered = query.trim() !== '' || scoped !== null || writable !== 'all';
  // The tree's selection is what Remove offers; "Other" is not a group ExifTool knows.
  const removable = scoped?.group ?? (scoped?.family === 'Other' ? undefined : scoped?.family);
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
          onClick={() => copy(tagsAsText(rows), `${rows.length} tags`)}
        >
          Copy visible
        </Button>
        <div className="inspector-changes" role="group" aria-label="Change metadata">
          <Button onClick={() => onEdit(null)}>Add tag…</Button>
          <Button onClick={() => onCopy(rows, removable)}>Copy to other files…</Button>
          <MenuButton
            align="end"
            items={[
              removable
                ? { label: `Remove ${removable} group…`, onSelect: () => onRemove(removable) }
                : {
                    label: 'Remove a group… (select one in the group list)',
                    disabled: true,
                    onSelect: () => undefined,
                  },
              {
                label: 'Remove all metadata…',
                separated: true,
                danger: true,
                onSelect: () => onRemove('All'),
              },
            ]}
          >
            Remove
          </MenuButton>
        </div>
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
            <table className="tags" aria-rowcount={rows.length + 1}>
              <caption className="visually-hidden">Tags of {file.sourceFile}</caption>
              {/* Fixed column widths: with automatic table layout, widths followed whichever
                  rows were drawn, so heights changed with scrolling and the rows never settled. */}
              <colgroup>
                <col className="tags-col-group" />
                <col className="tags-col-tag" />
                <col />
                <col className="tags-col-write" />
                <col className="tags-col-copy" />
              </colgroup>
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
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              {/* Per file: measured heights and the learned estimate belong to its tags. */}
              <TagRows
                key={file.sourceFile}
                rows={rows}
                onCopy={copy}
                onEdit={onEdit}
                staged={staged}
              />
            </table>
          )}
        </div>
      </div>
    </div>
  );
});
