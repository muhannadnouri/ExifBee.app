import { useMemo, useState } from 'react';
import { Button } from '../../components/atoms/Button';
import { Checkbox } from '../../components/atoms/Checkbox';
import { Select } from '../../components/atoms/Select';
import { TextField } from '../../components/atoms/TextField';
import { Dialog } from '../../components/Dialog';
import type { CopySelection, FileMetadata, ImportedFile, TagEntry } from '../../lib/ipc';
import { groupTree } from '../metadata/tagFilter';
import type { Change } from './StagedChanges';
import './CopyTagsDialog.css';

type Props = {
  sourceId: string;
  source: FileMetadata;
  /** Every file added in this session; the source itself is left out of the destinations. */
  files: ImportedFile[];
  /** The tag rows the table shows now (search, Show filter and group applied). */
  shown: TagEntry[];
  /** The group selected in the tree, offered first. */
  group: string | undefined;
  onStage: (destinations: string[], change: Change) => void;
  onClose: () => void;
};

/** Groups ExifTool does not copy: file-system facts, derived values, its notes, file structure. */
const NOT_COPIED = ['System', 'Composite', 'ExifTool', 'File', 'Other'];
/** Destinations drawn at once; "Select all matching" still covers every match (UX at scale). */
const LIST_LIMIT = 200;

/**
 * Copy tags from the inspected file to other session files (S4-T06, DEC-033): all metadata, one
 * group, or exactly the tags the table shows. Each destination gets a staged copy; Review
 * changes then dry-runs it per file and lists what it gets and what it cannot hold.
 */
export function CopyTagsDialog({ sourceId, source, files, shown, group, onStage, onClose }: Props) {
  const sourceName = source.sourceFile.split('/').pop() ?? source.sourceFile;
  const groups = useMemo(
    () =>
      groupTree(source.tags)
        .flatMap(({ family, groups }) => [family, ...groups.map(({ group }) => group)])
        .filter((name, index, all) => !NOT_COPIED.includes(name) && all.indexOf(name) === index),
    [source.tags],
  );
  const tags = useMemo(() => {
    const keys = new Set<string>();
    return shown
      .filter((tag) => !NOT_COPIED.includes(tag.group1))
      .filter(
        (tag) => !keys.has(`${tag.group1}:${tag.name}`) && keys.add(`${tag.group1}:${tag.name}`),
      )
      .map((tag) => ({ group: tag.group1, name: tag.name }));
  }, [shown]);
  const [kind, setKind] = useState<CopySelection['kind']>(
    group && groups.includes(group) ? 'group' : 'all',
  );
  const [chosenGroup, setChosenGroup] = useState(
    group && groups.includes(group) ? group : (groups[0] ?? ''),
  );
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState<Set<string>>(new Set());

  const others = files.filter((file) => file.id !== sourceId);
  const needle = query.trim().toLowerCase();
  const matching = needle
    ? others.filter((file) => file.path.toLowerCase().includes(needle))
    : others;
  const what: CopySelection =
    kind === 'all' ? { kind } : kind === 'group' ? { kind, group: chosenGroup } : { kind, tags };
  const valid = (kind !== 'group' || chosenGroup !== '') && (kind !== 'tags' || tags.length > 0);
  const toggle = (id: string, on: boolean) =>
    setChosen((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  return (
    <Dialog id="copy-tags" title="Copy tags to other files" open onClose={onClose}>
      <div className="copy-tags">
        <p>
          <span className="muted">From</span> <strong>{sourceName}</strong>
        </p>
        <fieldset className="copy-tags-what">
          <legend>What to copy</legend>
          <label>
            <input type="radio" checked={kind === 'all'} onChange={() => setKind('all')} /> All
            metadata
          </label>
          <div className="copy-tags-group">
            <label>
              <input
                type="radio"
                checked={kind === 'group'}
                disabled={groups.length === 0}
                onChange={() => setKind('group')}
              />{' '}
              One group
            </label>
            <Select
              aria-label="Group to copy"
              value={chosenGroup}
              options={groups.map((name) => ({ value: name, label: name }))}
              disabled={groups.length === 0}
              onChange={(value) => {
                setChosenGroup(value);
                setKind('group');
              }}
            />
          </div>
          <label>
            <input
              type="radio"
              checked={kind === 'tags'}
              disabled={tags.length === 0}
              onChange={() => setKind('tags')}
            />{' '}
            The {tags.length === 1 ? 'tag' : `${tags.length} tags`} shown in the table
          </label>
        </fieldset>
        <fieldset className="copy-tags-to">
          <legend>Copy to</legend>
          {others.length === 0 ? (
            <p className="muted">Add other files to copy to.</p>
          ) : (
            <>
              <TextField
                label="Find files"
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <ul className="copy-tags-files" aria-label="Files to copy to" tabIndex={0}>
                {matching.slice(0, LIST_LIMIT).map((file) => (
                  <li key={file.id}>
                    <Checkbox
                      label={file.name}
                      checked={chosen.has(file.id)}
                      onChange={(on) => toggle(file.id, on)}
                    />
                  </li>
                ))}
              </ul>
              {matching.length > LIST_LIMIT && (
                <p className="muted">
                  Showing {LIST_LIMIT} of {matching.length.toLocaleString('en-US')}; type to narrow.
                </p>
              )}
              <div className="copy-tags-select">
                <Button
                  disabled={matching.length === 0}
                  onClick={() =>
                    setChosen((current) => new Set([...current, ...matching.map(({ id }) => id)]))
                  }
                >
                  Select all {matching.length.toLocaleString('en-US')} matching
                </Button>
                <Button disabled={chosen.size === 0} onClick={() => setChosen(new Set())}>
                  Clear
                </Button>
                <span className="muted" role="status">
                  {chosen.size.toLocaleString('en-US')} chosen
                </span>
              </div>
            </>
          )}
        </fieldset>
        <p className="muted">
          Review changes shows what each file would get, and which tags it cannot hold.
        </p>
        <div className="dialog-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            className="button-primary"
            disabled={!valid || chosen.size === 0}
            onClick={() => {
              onStage([...chosen], { kind: 'copyTags', source: sourceId, what, sourceName });
              onClose();
            }}
          >
            {chosen.size === 1 ? 'Stage copy to 1 file' : `Stage copy to ${chosen.size} files`}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
