import type { SelectHTMLAttributes } from 'react';
import './Select.css';

type Props<T extends string> = Omit<
  SelectHTMLAttributes<HTMLSelectElement>,
  'value' | 'onChange'
> & {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
};

/** Native dropdown with typed options; the native control keeps OS keyboard and screen-reader behavior. */
export function Select<T extends string>({
  className,
  value,
  options,
  onChange,
  ...props
}: Props<T>) {
  return (
    <select
      className={className ? `select ${className}` : 'select'}
      value={value}
      // Safe: the only values the control can produce are the ones rendered from `options`.
      onChange={(event) => onChange(event.target.value as T)}
      {...props}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}
