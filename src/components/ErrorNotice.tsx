import type { ReactNode } from 'react';
import { ERROR_TEXT } from '../lib/errors';
import type { AppError } from '../lib/ipc';
import { Notice } from './atoms/Notice';
import './ErrorNotice.css';

/** Any `AppError`, shown the same way everywhere: category title, specific detail, then a hint. */
export function ErrorNotice({ error, actions }: { error: AppError; actions?: ReactNode }) {
  const { title, hint } = ERROR_TEXT[error.kind];
  return (
    <Notice tone="error" actions={actions}>
      <strong className="error-notice-title">{title}</strong>
      <span className="error-notice-detail">{error.message}</span>
      <span className="error-notice-hint">{hint}</span>
    </Notice>
  );
}
