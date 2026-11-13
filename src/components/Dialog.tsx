import { useEffect, useRef } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { IconButton } from './atoms/IconButton';
import './Dialog.css';

type Props = { id: string; title: string; open: boolean; onClose: () => void; children: ReactNode };

/**
 * Modal built on the native <dialog>: Esc closes it and the rest of the page is inert. Tab wraps
 * within the dialog (WAI-ARIA dialog pattern), and focus returns to whatever opened it.
 */
export function Dialog({ id, title, open, onClose, children }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<Element | null>(null);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      opener.current = document.activeElement;
      element.showModal();
    } else if (!open && element.open) {
      element.close();
    }
  }, [open]);

  // Native modals let Tab leave the document after the last control; a desktop app has no
  // browser UI to land on, so wrap explicitly.
  const wrapTab = (event: KeyboardEvent<HTMLDialogElement>) => {
    if (event.key !== 'Tab') return;
    const focusable = [
      ...event.currentTarget.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ),
    ].filter((element) => !element.hasAttribute('disabled'));
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <dialog
      ref={dialog}
      onKeyDown={wrapTab}
      className="dialog"
      aria-labelledby={`${id}-title`}
      onClose={(event) => {
        // React passes a nested dialog's close up the component tree; only our own counts.
        if (event.target !== event.currentTarget) return;
        onClose();
        if (opener.current instanceof HTMLElement) opener.current.focus();
      }}
    >
      <header className="dialog-header">
        <h2 id={`${id}-title`}>{title}</h2>
        <IconButton icon="remove" label="Close" onClick={() => dialog.current?.close()} />
      </header>
      <div className="dialog-body">{children}</div>
    </dialog>
  );
}
