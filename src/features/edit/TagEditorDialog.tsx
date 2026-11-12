import { useEffect, useState } from 'react';
import { Button } from '../../components/atoms/Button';
import { IconButton } from '../../components/atoms/IconButton';
import { Notice } from '../../components/atoms/Notice';
import { TextField } from '../../components/atoms/TextField';
import { Dialog } from '../../components/Dialog';
import { rawTextIsUtf8, searchTags } from '../../lib/ipc';
import type { FileMetadata, TagCapability, TagEntry } from '../../lib/ipc';
import { valueText } from '../metadata/tagFilter';
import type { Change } from './StagedChanges';
import './TagEditorDialog.css';

type Props = {
  fileId: string;
  file: FileMetadata;
  /** The tag to edit, or `null` to add one the file does not have yet. */
  tag: TagEntry | null;
  /** Called with the change and the value it replaces (`null` for a new tag). */
  onStage: (edit: Change, before: string | null) => void;
  onClose: () => void;
};

type Target = { group: string; name: string; tag: TagEntry | null; listed: TagCapability | null };

// Wording from SPEC §5.5.
export const READ_ONLY =
  'This tag or file format is not writable through the selected ExifTool version.';
/** ExifTool would replace a read-only file anyway, so ExifBee refuses first (DEC-029). */
export const NO_PERMISSION =
  'You do not have permission to change this file or the folder it is in, so it is left as it is.';
const UNKNOWN =
  'Write support could not be confirmed. ExifTool may reject this operation; the original will be backed up.';

/** Why this tag cannot be changed or deleted at all, if it cannot (nothing is staged silently). */
function blocker(file: FileMetadata, target: Target): string | null {
  const { group, name, tag } = target;
  if (file.writeAccess === false) return NO_PERMISSION;
  if (group === 'System')
    return 'File system properties (name, folder, dates, permissions) change the file itself, so they are not edited as tags.';
  if (tag?.writable === 'readOnly' || (!tag && file.formatWritable === false)) return READ_ONLY;
  const same = file.tags.filter((other) => other.group1 === group && other.name === name);
  if (same.length > 1)
    return `This file has ${same.length} ${group}:${name} tags; ExifTool cannot change one of them on its own.`;
  return null;
}

/** Why this tag's value cannot be edited as text, if it cannot; it may still be deleted. */
function valueBlocker(tag: TagEntry | null): string | null {
  if (tag && tag.value.kind !== 'text' && tag.value.kind !== 'list')
    return 'Structures and binary data need dedicated operations to edit, which are not available yet. The tag can still be deleted.';
  if (tag?.value.kind === 'list' && tag.value.items.some((item) => item.kind !== 'text'))
    return 'This list holds structures, which need dedicated operations to edit. The tag can still be deleted.';
  return null;
}

/**
 * Edit one tag's value, or add a tag, and stage the change (S4-T01, DEC-028). Nothing is written
 * here: staged changes wait in the Actions drawer for the plan and confirmation step.
 *
 * Values are display text as ExifTool prints it, written back exactly; lists are edited item by
 * item, so an item with a comma stays one item. Before editing stored text, Rust re-reads it
 * with `-b`: text that is not valid UTF-8 is shown with `?` and must not be written back.
 */
export function TagEditorDialog({ fileId, file, tag, onStage, onClose }: Props) {
  const [target, setTarget] = useState<Target | null>(
    tag ? { group: tag.group1, name: tag.name, tag, listed: null } : null,
  );
  const isList = target?.tag?.value.kind === 'list';
  const [asList, setAsList] = useState(isList);
  const [text, setText] = useState(tag?.value.kind === 'text' ? tag.value.text : '');
  const [items, setItems] = useState<string[]>(
    tag?.value.kind === 'list' ? tag.value.items.map(valueText) : [''],
  );
  const [bytesOk, setBytesOk] = useState<boolean | null>(tag ? null : true);
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<TagCapability[]>([]);
  const [total, setTotal] = useState(0);

  // Stored text must be valid UTF-8 before editing starts from what is shown (DEC-019).
  useEffect(() => {
    if (!target?.tag) return;
    let live = true;
    rawTextIsUtf8(fileId, target.group, target.name).then(
      (ok) => live && setBytesOk(ok),
      () => live && setBytesOk(false),
    );
    return () => {
      live = false;
    };
  }, [fileId, target]);

  // Add tag: search ExifTool's writable tags as the user types.
  useEffect(() => {
    if (target) return;
    let live = true;
    const timer = window.setTimeout(() => {
      searchTags(query).then(
        (page) => {
          if (!live) return;
          setFound(page.tags);
          setTotal(page.total);
        },
        () => live && setFound([]),
      );
    }, 150);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [query, target]);

  const pick = (listed: TagCapability) => {
    // A tag the file already has is edited, not added twice.
    const existing = file.tags.find((t) => t.group1 === listed.group1 && t.name === listed.name);
    if (existing) {
      setText(existing.value.kind === 'text' ? existing.value.text : '');
      setItems(existing.value.kind === 'list' ? existing.value.items.map(valueText) : ['']);
      setAsList(existing.value.kind === 'list');
      setBytesOk(null);
    }
    setTarget({ group: listed.group1, name: listed.name, tag: existing ?? null, listed });
  };

  const problem = target ? blocker(file, target) : null;
  const valueProblem = target && !problem ? valueBlocker(target.tag) : null;
  const unknown =
    target &&
    !problem &&
    (target.tag?.writable === 'unknown' || (!target.tag && file.formatWritable === null));
  const value = asList ? { kind: 'list' as const, items } : { kind: 'text' as const, text };
  const before = target?.tag ? valueText(target.tag.value) : null;
  const after = asList ? items.join(', ') : text;
  const listInvalid = asList && (items.length === 0 || items.some((item) => item === ''));
  const unchanged =
    target?.tag !== null && target?.tag !== undefined && before === after && isList === asList;
  const canStage =
    target && !problem && !valueProblem && bytesOk === true && !listInvalid && !unchanged;

  const moveItem = (from: number, to: number) =>
    setItems((current) => {
      const next = [...current];
      const [item] = next.splice(from, 1);
      if (item !== undefined) next.splice(to, 0, item);
      return next;
    });

  return (
    <Dialog id="tag-editor" title={tag ? 'Edit tag' : 'Add tag'} open onClose={onClose}>
      <form
        className="tag-editor"
        onSubmit={(event) => {
          event.preventDefault();
          if (canStage && target) {
            onStage({ kind: 'set', group: target.group, name: target.name, value }, before);
            onClose();
          }
        }}
      >
        {!target ? (
          <>
            <TextField
              label="Find a writable tag"
              type="search"
              placeholder="Group:Tag, e.g. XMP-dc:Creator"
              value={query}
              autoFocus
              onChange={(event) => setQuery(event.target.value)}
            />
            <p className="muted" role="status">
              {total > found.length
                ? `Showing ${found.length} of ${total.toLocaleString('en-US')}; type more to narrow.`
                : `${found.length} writable ${found.length === 1 ? 'tag' : 'tags'}`}
            </p>
            <ul className="tag-editor-results">
              {found.map((listed) => (
                <li key={`${listed.group1}:${listed.name}`}>
                  <Button onClick={() => pick(listed)}>
                    {listed.group1}:{listed.name}
                    <span className="muted"> {listed.group0}</span>
                  </Button>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <>
            <p className="tag-editor-target">
              <span className="muted">{file.sourceFile.split('/').pop()}</span>
              <strong>
                {target.group}:{target.name}
              </strong>
            </p>
            {problem && <Notice tone="warning">{problem}</Notice>}
            {valueProblem && <Notice tone="info">{valueProblem}</Notice>}
            {!problem && !valueProblem && bytesOk === false && (
              <Notice tone="warning">
                This value holds bytes that are not text, so what is shown is not what is stored. It
                cannot be edited from here without losing them.
              </Notice>
            )}
            {unknown && <Notice tone="warning">{UNKNOWN}</Notice>}
            {!problem && !valueProblem && bytesOk !== false && (
              <>
                {!target.tag && (
                  <fieldset className="tag-editor-kind">
                    <legend>Value</legend>
                    <label>
                      <input type="radio" checked={!asList} onChange={() => setAsList(false)} /> One
                      value
                    </label>
                    <label>
                      <input type="radio" checked={asList} onChange={() => setAsList(true)} /> A
                      list of values
                    </label>
                  </fieldset>
                )}
                {asList ? (
                  <fieldset className="tag-editor-list">
                    <legend>Items</legend>
                    {items.map((item, index) => (
                      <div key={index} className="tag-editor-item">
                        <TextField
                          label={`Item ${index + 1}`}
                          value={item}
                          onChange={(event) =>
                            setItems((current) =>
                              current.map((old, at) => (at === index ? event.target.value : old)),
                            )
                          }
                        />
                        <IconButton
                          icon="arrow-up"
                          label={`Move item ${index + 1} up`}
                          disabled={index === 0}
                          onClick={() => moveItem(index, index - 1)}
                        />
                        <IconButton
                          icon="arrow-down"
                          label={`Move item ${index + 1} down`}
                          disabled={index === items.length - 1}
                          onClick={() => moveItem(index, index + 1)}
                        />
                        <IconButton
                          icon="remove"
                          label={`Remove item ${index + 1}`}
                          onClick={() =>
                            setItems((current) => current.filter((_, at) => at !== index))
                          }
                        />
                      </div>
                    ))}
                    <Button onClick={() => setItems((current) => [...current, ''])}>
                      Add item
                    </Button>
                    {listInvalid && <p className="muted">Every item needs a value.</p>}
                  </fieldset>
                ) : (
                  <label className="tag-editor-text">
                    <span>New value</span>
                    <textarea
                      value={text}
                      rows={3}
                      onChange={(event) => setText(event.target.value)}
                    />
                  </label>
                )}
                {!target.tag || bytesOk ? null : (
                  <p className="muted">Checking the stored value…</p>
                )}
              </>
            )}
          </>
        )}
        <div className="dialog-actions">
          {target?.tag && !problem && (
            <Button
              className="button-danger dialog-actions-start"
              onClick={() => {
                onStage({ kind: 'deleteTag', group: target.group, name: target.name }, before);
                onClose();
              }}
            >
              Delete tag
            </Button>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" className="button-primary" disabled={!canStage}>
            Stage change
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
