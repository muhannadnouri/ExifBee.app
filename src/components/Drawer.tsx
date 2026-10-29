import type { ReactNode } from 'react';
import './Drawer.css';

type Props = {
  id: string;
  title: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
};

/** Collapsible bottom panel; its header button keeps focus when it opens or closes. */
export function Drawer({ id, title, open, onToggle, children }: Props) {
  return (
    <section className="drawer" aria-labelledby={`${id}-title`}>
      <h2 className="drawer-header" id={`${id}-title`}>
        <button type="button" aria-expanded={open} aria-controls={id} onClick={onToggle}>
          {open ? '▾' : '▸'} {title}
        </button>
      </h2>
      {open && (
        // Tab stop so keyboard users can scroll long drawer content.
        <div className="drawer-body" id={id} tabIndex={0}>
          {children}
        </div>
      )}
    </section>
  );
}
