import type { KeyboardEvent, PointerEvent } from 'react';
import './Splitter.css';

const STEP = 16;

type Props = {
  label: string;
  /** `vertical` sits between columns and sizes the pane before it; `horizontal` sizes the pane below it. */
  orientation: 'vertical' | 'horizontal';
  value: number;
  min: number;
  max: number;
  controls: string;
  onChange: (value: number) => void;
};

/** Focusable window splitter (WAI-ARIA separator): drag with the pointer or use arrow keys, Home and End. */
export function Splitter({ label, orientation, value, min, max, controls, onChange }: Props) {
  const clamp = (next: number) => Math.min(max, Math.max(min, Math.round(next)));
  // Moving right grows the left pane; moving up grows the pane below.
  const grow = orientation === 'vertical' ? 'ArrowRight' : 'ArrowUp';
  const shrink = orientation === 'vertical' ? 'ArrowLeft' : 'ArrowDown';

  const onKeyDown = (event: KeyboardEvent) => {
    const next =
      event.key === grow
        ? value + STEP
        : event.key === shrink
          ? value - STEP
          : event.key === 'Home'
            ? min
            : event.key === 'End'
              ? max
              : null;
    if (next === null) return;
    event.preventDefault();
    onChange(clamp(next));
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const handle = event.currentTarget;
    const start = orientation === 'vertical' ? event.clientX : event.clientY;
    const startValue = value;
    handle.setPointerCapture(event.pointerId);
    const move = (moveEvent: globalThis.PointerEvent) => {
      const position = orientation === 'vertical' ? moveEvent.clientX : moveEvent.clientY;
      const delta = orientation === 'vertical' ? position - start : start - position;
      onChange(clamp(startValue + delta));
    };
    const stop = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', stop);
      handle.removeEventListener('pointercancel', stop);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
  };

  return (
    <div
      className={`splitter splitter-${orientation}`}
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation={orientation}
      aria-controls={controls}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
    />
  );
}
