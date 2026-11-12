import { useEffect, useState } from 'react';
import { Button } from '../../components/atoms/Button';
import { Checkbox } from '../../components/atoms/Checkbox';
import { Notice } from '../../components/atoms/Notice';
import { Dialog } from '../../components/Dialog';
import { cancelRemovalPreview, previewRemoval } from '../../lib/ipc';
import type { FileMetadata, RemovalPreview } from '../../lib/ipc';
import { toAppError } from '../../lib/errors';
import type { Change } from './StagedChanges';
import { NO_PERMISSION, READ_ONLY } from './TagEditorDialog';
import './RemoveGroupDialog.css';

type Props = {
  fileId: string;
  file: FileMetadata;
  /** A family-0 or family-1 group (`XMP`, `IFD0`), or `All` for all metadata. */
  group: string;
  onStage: (edit: Change, before: null) => void;
  onClose: () => void;
};

type State =
  | { phase: 'checking' }
  | { phase: 'ready'; preview: RemovalPreview }
  | { phase: 'failed'; message: string };

/**
 * Remove one group, or all metadata, and stage it (S4-T02, DEC-029). What goes is found by
 * removing it from a private copy (`preview_removal`), because groups nest: removing IFD0 also
 * removes ExifIFD. All metadata is high impact (SPEC §4.6), so it needs an explicit tick.
 */
export function RemoveGroupDialog({ fileId, file, group, onStage, onClose }: Props) {
  const all = group === 'All';
  const fileName = file.sourceFile.split('/').pop() ?? file.sourceFile;
  const refusal =
    file.writeAccess === false ? NO_PERMISSION : file.formatWritable === false ? READ_ONLY : null;
  const [state, setState] = useState<State>({ phase: 'checking' });
  const [understood, setUnderstood] = useState(false);

  useEffect(() => {
    if (refusal) return;
    let live = true;
    let running = true;
    previewRemoval(fileId, group)
      .then(
        (preview) => live && setState({ phase: 'ready', preview }),
        (error: unknown) =>
          live && setState({ phase: 'failed', message: toAppError(error).message }),
      )
      .finally(() => (running = false));
    return () => {
      live = false;
      // Closing early stops ExifTool from copying a large file for nothing.
      if (running) void cancelRemovalPreview().catch(() => undefined);
    };
  }, [fileId, group, refusal]);

  const removed = state.phase === 'ready' ? state.preview.removed : [];
  const groups = new Map<string, string[]>();
  for (const tag of removed) groups.set(tag.group1, [...(groups.get(tag.group1) ?? []), tag.name]);
  // Groups that go with the chosen one because they are stored inside it (IFD0 holds ExifIFD).
  const along = all
    ? []
    : [...groups.keys()].filter(
        (name) =>
          name !== group && !removed.some((tag) => tag.group1 === name && tag.group0 === group),
      );
  const inGroup = (tag: FileMetadata['tags'][number]) =>
    all ? true : tag.group1 === group || tag.group0 === group;
  const kept = file.tags.filter(
    (tag) =>
      inGroup(tag) &&
      !['System', 'ExifTool', 'Composite'].includes(tag.group1) &&
      !removed.some((gone) => gone.key === tag.key),
  ).length;
  const canStage = removed.length > 0 && (!all || understood);

  return (
    <Dialog
      id="remove-group"
      title={all ? 'Remove all metadata' : `Remove ${group} group`}
      open
      onClose={onClose}
    >
      <div className="remove-group">
        <p className="remove-group-file">
          <span className="muted">From</span> <strong>{fileName}</strong>
        </p>
        {refusal && <Notice tone="warning">{refusal}</Notice>}
        {!refusal && state.phase === 'checking' && (
          <p role="status">
            Working out what this removes, by trying it on a private copy. Your file is not changed.
          </p>
        )}
        {state.phase === 'failed' && <Notice tone="error">{state.message}</Notice>}
        {state.phase === 'ready' && removed.length === 0 && (
          <Notice tone="info">
            Nothing to remove: ExifTool finds no {all ? 'metadata' : `${group} tags`} it can remove
            from this file.
            {state.preview.messages.length > 0 &&
              ` ExifTool says: ${state.preview.messages.join(' ')}`}
          </Notice>
        )}
        {removed.length > 0 && (
          <>
            <p role="status">
              Removes <strong>{removed.length}</strong> {removed.length === 1 ? 'tag' : 'tags'} in{' '}
              {groups.size} {groups.size === 1 ? 'group' : 'groups'}:
            </p>
            <ul className="remove-group-list" aria-label="Tags that would be removed" tabIndex={0}>
              {[...groups].map(([name, tags]) => (
                <li key={name}>
                  <strong>{name}</strong> <span className="muted">({tags.length})</span>{' '}
                  {tags.join(', ')}
                </li>
              ))}
            </ul>
            {along.length > 0 && (
              <Notice tone="warning">
                Also removes {along.join(', ')}, because {along.length === 1 ? 'it is' : 'they are'}{' '}
                stored inside {group}.
              </Notice>
            )}
            {kept > 0 && (
              <p className="muted">
                {kept} {kept === 1 ? 'tag stays' : 'tags stay'}: ExifTool cannot remove{' '}
                {kept === 1 ? 'it' : 'them'} (for example, image size is part of the file itself).
              </p>
            )}
            {/\.pdf$/i.test(fileName) && (
              <Notice tone="warning">
                PDF changes are added to the end of the file: removed values are hidden from readers
                but can still be recovered from the file.
              </Notice>
            )}
            <p className="muted">
              Nothing is written yet. When applied, ExifTool keeps the original as {fileName}
              _original.
            </p>
            {all && (
              <Checkbox
                label={`I understand this removes all metadata from ${fileName}, which can include its color profile and orientation and change how it looks.`}
                checked={understood}
                onChange={setUnderstood}
              />
            )}
          </>
        )}
        <div className="dialog-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            className={all ? 'button-danger' : 'button-primary'}
            disabled={!canStage}
            onClick={() => {
              onStage(
                {
                  kind: 'deleteGroup',
                  group,
                  removed: removed.map((tag) => `${tag.group1}:${tag.name}`),
                },
                null,
              );
              onClose();
            }}
          >
            {removed.length > 0
              ? `Stage removal of ${removed.length} ${removed.length === 1 ? 'tag' : 'tags'}`
              : 'Stage removal'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
