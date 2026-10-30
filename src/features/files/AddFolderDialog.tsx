import { useState } from 'react';
import { Button } from '../../components/atoms/Button';
import { Checkbox } from '../../components/atoms/Checkbox';
import { TextField } from '../../components/atoms/TextField';
import { Dialog } from '../../components/Dialog';
import type { ScanOptions } from '../../lib/ipc';
import './AddFolderDialog.css';

type Props = {
  /** The folder chosen in the native dialog (display only; Rust keeps the real one). */
  folder: string | null;
  /** Options to start from: the ones used last in this session. */
  options: ScanOptions;
  onChooseAgain: () => void;
  onAdd: (options: ScanOptions) => void;
  onClose: () => void;
};

const toList = (text: string) => text.split(/[\s,]+/).filter(Boolean);

/** The policy in words, shown wherever a scan's options matter. */
export function describeScanOptions(options: ScanOptions) {
  return [
    options.recursive ? 'Subfolders' : 'This folder only',
    options.includeHidden ? 'hidden files included' : 'no hidden files',
    options.followOutsideLinks ? 'links outside followed' : 'links outside not followed',
    options.includeExtensions.length > 0 && `only .${options.includeExtensions.join(', .')}`,
    options.excludeExtensions.length > 0 && `not .${options.excludeExtensions.join(', .')}`,
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * Step two of Add folder (DEC-023): the folder was just chosen in the native dialog; here the
 * user sees its path and the options at the moment of decision, then confirms. Extension
 * filters, rarely needed, sit behind a disclosure.
 */
export function AddFolderDialog({ folder, options, onChooseAgain, onAdd, onClose }: Props) {
  const [draft, setDraft] = useState(options);
  const [include, setInclude] = useState(options.includeExtensions.join(', '));
  const [exclude, setExclude] = useState(options.excludeExtensions.join(', '));
  const update = (change: Partial<ScanOptions>) =>
    setDraft((current) => ({ ...current, ...change }));

  return (
    <Dialog id="add-folder" title="Add folder" open={folder !== null} onClose={onClose}>
      <form
        className="add-folder"
        method="dialog"
        onSubmit={(event) => {
          event.preventDefault();
          onAdd({
            ...draft,
            includeExtensions: toList(include),
            excludeExtensions: toList(exclude),
          });
        }}
      >
        <div className="add-folder-path">
          <span className="add-folder-label" id="add-folder-path-label">
            Folder
          </span>
          <output aria-labelledby="add-folder-path-label" title={folder ?? undefined}>
            {folder}
          </output>
          <Button onClick={onChooseAgain}>Choose…</Button>
        </div>
        <Checkbox
          label="Include subfolders"
          checked={draft.recursive}
          onChange={(recursive) => update({ recursive })}
        />
        <Checkbox
          label="Include hidden files and folders"
          checked={draft.includeHidden}
          onChange={(includeHidden) => update({ includeHidden })}
        />
        <Checkbox
          label="Follow links that point outside the folder"
          checked={draft.followOutsideLinks}
          onChange={(followOutsideLinks) => update({ followOutsideLinks })}
        />
        <details className="add-folder-filters" open={include !== '' || exclude !== ''}>
          <summary>Filter by extension</summary>
          <TextField
            label="Only these extensions (empty = all)"
            placeholder="jpg, png, pdf"
            value={include}
            onChange={(event) => setInclude(event.target.value)}
          />
          <TextField
            label="Skip these extensions"
            placeholder="tmp, bak"
            value={exclude}
            onChange={(event) => setExclude(event.target.value)}
          />
        </details>
        <div className="add-folder-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" className="button-primary">
            Add folder
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
