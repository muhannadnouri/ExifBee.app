import type { InputHTMLAttributes } from 'react';
import './TextField.css';

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & {
  label: string;
  type?: 'text' | 'search';
};

/** Labelled single-line text input. */
export function TextField({ label, type = 'text', ...props }: Props) {
  return (
    <label className="text-field">
      <span>{label}</span>
      <input type={type} {...props} />
    </label>
  );
}
