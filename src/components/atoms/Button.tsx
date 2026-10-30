import type { ComponentProps } from 'react';
import './Button.css';

/** Standard push button; defaults to `type="button"` so it never submits a form by accident. */
export function Button({ className, type = 'button', ...props }: ComponentProps<'button'>) {
  return <button type={type} className={className ? `button ${className}` : 'button'} {...props} />;
}
