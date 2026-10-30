import type { InputHTMLAttributes } from 'react';
import './TextField.css';

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { label: string };

/** Labelled single-line text input. */
export function TextField({ label, ...props }: Props) {
  return (
    <label className="text-field">
      <span>{label}</span>
      <input type="text" {...props} />
    </label>
  );
}
