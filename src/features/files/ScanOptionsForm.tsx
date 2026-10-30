import { useState } from 'react';
import { Checkbox } from '../../components/atoms/Checkbox';
import { TextField } from '../../components/atoms/TextField';
import type { ScanOptions } from '../../lib/ipc';
import './ScanOptionsForm.css';

type Props = { options: ScanOptions; onChange: (options: ScanOptions) => void };

const toList = (text: string) => text.split(/[\s,]+/).filter(Boolean);

/** The policy in force, in words, so it shows even while the form is collapsed. */
export function describeScanOptions(options: ScanOptions) {
  return [
    options.recursive ? 'with subfolders' : 'this folder only',
    options.includeHidden ? 'hidden files included' : 'no hidden files',
    options.followOutsideLinks ? 'links outside followed' : 'links outside not followed',
    options.includeExtensions.length > 0 && `only .${options.includeExtensions.join(', .')}`,
    options.excludeExtensions.length > 0 && `not .${options.excludeExtensions.join(', .')}`,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Options for Add folder… and dropped folders; extension lists apply when the field loses focus. */
export function ScanOptionsForm({ options, onChange }: Props) {
  // Typed text stays local until committed, so a half-typed list never reaches Rust.
  const [include, setInclude] = useState<string | null>(null);
  const [exclude, setExclude] = useState<string | null>(null);
  const update = (change: Partial<ScanOptions>) => onChange({ ...options, ...change });

  return (
    <details className="scan-options">
      <summary>
        Folder options <span className="muted">({describeScanOptions(options)})</span>
      </summary>
      <div className="scan-options-fields">
        <Checkbox
          label="Include subfolders"
          checked={options.recursive}
          onChange={(recursive) => update({ recursive })}
        />
        <Checkbox
          label="Include hidden files and folders"
          checked={options.includeHidden}
          onChange={(includeHidden) => update({ includeHidden })}
        />
        <Checkbox
          label="Follow links that point outside the folder"
          checked={options.followOutsideLinks}
          onChange={(followOutsideLinks) => update({ followOutsideLinks })}
        />
        <TextField
          label="Only these extensions (empty = all)"
          placeholder="jpg, png, pdf"
          value={include ?? options.includeExtensions.join(', ')}
          onChange={(event) => setInclude(event.target.value)}
          onBlur={() => {
            if (include !== null) update({ includeExtensions: toList(include) });
            setInclude(null);
          }}
        />
        <TextField
          label="Skip these extensions"
          placeholder="tmp, bak"
          value={exclude ?? options.excludeExtensions.join(', ')}
          onChange={(event) => setExclude(event.target.value)}
          onBlur={() => {
            if (exclude !== null) update({ excludeExtensions: toList(exclude) });
            setExclude(null);
          }}
        />
      </div>
    </details>
  );
}
