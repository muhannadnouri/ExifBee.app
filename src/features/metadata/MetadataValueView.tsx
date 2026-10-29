import type { MetadataValue } from '../../lib/ipc';
import './MetadataValueView.css';

const bytes = (count: number | null) =>
  count === null ? 'unknown size' : `${count.toLocaleString()} ${count === 1 ? 'byte' : 'bytes'}`;

/**
 * Renders a typed ExifTool value as text only (never HTML): lists of plain text read as
 * "a, b, c", anything nested is shown as a nested list, structures as field lists, and binary
 * data as a size descriptor instead of garbled bytes (FR-023).
 */
export function MetadataValueView({ value }: { value: MetadataValue }) {
  switch (value.kind) {
    case 'text':
      return value.text === '' ? <span className="muted">(empty)</span> : <>{value.text}</>;
    case 'binary':
      return <span className="metadata-binary">Binary data · {bytes(value.byteLength)}</span>;
    case 'list':
      if (value.items.every((item) => item.kind === 'text')) {
        return <>{value.items.map((item) => (item.kind === 'text' ? item.text : '')).join(', ')}</>;
      }
      return (
        <ul className="metadata-list">
          {value.items.map((item, index) => (
            <li key={index}>
              <MetadataValueView value={item} />
            </li>
          ))}
        </ul>
      );
    case 'structure':
      return (
        <dl className="metadata-structure">
          {value.fields.map((field) => (
            <div key={field.name}>
              <dt>{field.name}</dt>
              <dd>
                <MetadataValueView value={field.value} />
              </dd>
            </div>
          ))}
        </dl>
      );
  }
}
