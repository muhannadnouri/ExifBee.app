import type { ReactNode } from 'react';
import './Notice.css';

type Props = { tone: 'error' | 'warning'; children: ReactNode; actions?: ReactNode };

/** Inline banner for problems the user must see; errors are announced as alerts. */
export function Notice({ tone, children, actions }: Props) {
  return (
    <div
      className={`notice-banner notice-banner-${tone}`}
      role={tone === 'error' ? 'alert' : 'status'}
    >
      <div className="notice-banner-text">{children}</div>
      {actions && <div className="notice-banner-actions">{actions}</div>}
    </div>
  );
}
