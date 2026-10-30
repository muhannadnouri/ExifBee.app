import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { Button } from './atoms/Button';
import { Icon } from './atoms/Icon';
import './MenuButton.css';

export type MenuItem = { label: string; shortcut?: string; onSelect: () => void };

type Props = { children: ReactNode; items: MenuItem[]; disabled?: boolean };

/**
 * Button that opens a short menu (WAI-ARIA menu button pattern): Enter, Space or ↓ open it on
 * the first item, ↑/↓/Home/End move, Esc closes and returns focus, and a click outside or Tab
 * closes it. Choosing an item closes the menu first, then runs the item.
 */
export function MenuButton({ children, items, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const entries = () => [
    ...(root.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []),
  ];

  useEffect(() => {
    if (!open) return;
    entries()[0]?.focus();
    const close = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const onMenuKey = (event: KeyboardEvent) => {
    const list = entries();
    const at = list.indexOf(document.activeElement as HTMLElement);
    const next = {
      ArrowDown: (at + 1) % list.length,
      ArrowUp: (at - 1 + list.length) % list.length,
      Home: 0,
      End: list.length - 1,
    }[event.key];
    if (next !== undefined) {
      event.preventDefault();
      list[next]?.focus();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      button.current?.focus();
    } else if (event.key === 'Tab') {
      setOpen(false);
    }
  };

  return (
    <div className="menu-button" ref={root}>
      <Button
        ref={button}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        {children}
        <Icon name="chevron-down" />
      </Button>
      {open && (
        <ul className="menu" role="menu" id={id} onKeyDown={onMenuKey}>
          {items.map((item) => (
            <li key={item.label} role="none">
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                aria-keyshortcuts={item.shortcut?.replaceAll('Ctrl', 'Control')}
                onClick={() => {
                  setOpen(false);
                  button.current?.focus();
                  item.onSelect();
                }}
              >
                <span>{item.label}</span>
                {item.shortcut && <kbd>{item.shortcut}</kbd>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
