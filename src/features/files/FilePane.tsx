import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { AppError, FileMetadata, ImportedFile, ReadSummary } from '../../lib/ipc';
import './FilePane.css';

type Props = {
  files: ImportedFile[];
  reads: Record<string, FileMetadata>;
  /** Background read results; a full read of the selected file takes precedence. */
  summaries: Map<string, ReadSummary>;
  failures: Record<string, AppError>;
  selected: string | null;
  /** `fromKeyboard` is set while arrowing through the list, so the caller can wait before reading. */
  onSelect: (file: ImportedFile, fromKeyboard: boolean) => void;
  /** Called with the IDs of the rendered rows whenever they change, so they can be read first. */
  onVisibleChange: (ids: string[]) => void;
};

/** Rows drawn above and below the visible ones, so fast scrolling rarely shows a gap. */
const OVERSCAN = 20;

/**
 * Files added in this session, any format, as one keyboard-navigable list box.
 *
 * Only the rows in view are rendered (rows have a fixed height, measured from the first one), so
 * a scan adding files to a list of 200,000 costs the same as to a list of 20 (DEC-021). The list
 * is a single Tab stop: arrows, Home/End and Page Up/Down move the selection, and each row
 * announces its position (`aria-posinset`/`aria-setsize`) and full path.
 */
export function FilePane({
  files,
  reads,
  summaries,
  failures,
  selected,
  onSelect,
  onVisibleChange,
}: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  // Until measured (and in jsdom, which has no layout), assume a typical window and row.
  const [viewport, setViewport] = useState(600);
  const [rowHeight, setRowHeight] = useState(28);
  const empty = files.length === 0;

  // Measured when the first rows appear; text zoom changes are picked up on the next resize.
  useLayoutEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>('[role="option"]');
    if (row && row.offsetHeight > 0) setRowHeight(row.offsetHeight);
  }, [empty, viewport]);

  useEffect(() => {
    const list = listRef.current;
    if (!list || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setViewport(list.clientHeight));
    observer.observe(list);
    return () => observer.disconnect();
  }, [empty]);

  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN);
  const last = Math.min(files.length, Math.ceil((scrollTop + viewport) / rowHeight) + OVERSCAN);
  // Report the rendered range only when it really changes, not on every batch added below it.
  const visibleKey = `${files[first]?.id}:${files[last - 1]?.id}`;
  const onVisible = useEffectEvent(() =>
    onVisibleChange(files.slice(first, last).map((file) => file.id)),
  );
  useEffect(() => {
    if (!empty) onVisible();
  }, [visibleKey, empty]);

  if (empty)
    return <p className="muted">No files yet. Use Add files… or drop files onto the window.</p>;

  const current = files.findIndex((file) => file.id === selected);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const page = Math.max(1, Math.floor(viewport / rowHeight) - 1);
    const target = {
      ArrowDown: current + 1,
      ArrowUp: current < 0 ? 0 : current - 1,
      Home: 0,
      End: files.length - 1,
      PageDown: current + page,
      PageUp: current - page,
    }[event.key];
    if (target === undefined) return;
    event.preventDefault();
    const index = Math.min(files.length - 1, Math.max(0, target));
    const list = event.currentTarget;
    // Keep the selected row in view; the scroll event then renders the rows around it.
    if (index * rowHeight < list.scrollTop) list.scrollTop = index * rowHeight;
    else if ((index + 1) * rowHeight > list.scrollTop + list.clientHeight)
      list.scrollTop = (index + 1) * rowHeight - list.clientHeight;
    const file = files[index];
    if (file && index !== current) onSelect(file, true);
  };

  return (
    <div
      ref={listRef}
      className="file-list"
      role="listbox"
      aria-labelledby="files-title"
      tabIndex={0}
      aria-activedescendant={current >= first && current < last ? `file-${selected}` : undefined}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      onKeyDown={onKeyDown}
    >
      {/* Padding stands in for the rows not rendered; it lives here because a scroll container
          cannot shrink below its own padding. */}
      <div
        role="presentation"
        style={{
          paddingTop: first * rowHeight,
          paddingBottom: (files.length - last) * rowHeight,
        }}
      >
        {files.slice(first, last).map((file, offset) => {
          const read = reads[file.id] ?? summaries.get(file.id);
          // An unknown format is expected for arbitrary files, so it is flagged neutrally.
          const flag = failures[file.id]
            ? ' (error)'
            : read?.unsupported
              ? ' (unsupported)'
              : read?.error
                ? ' (error)'
                : read && read.warnings.length > 0
                  ? ' (warning)'
                  : '';
          return (
            <div
              key={file.id}
              id={`file-${file.id}`}
              role="option"
              className="file-option"
              aria-selected={file.id === selected}
              aria-posinset={first + offset + 1}
              aria-setsize={files.length}
              aria-label={file.path + flag}
              title={file.path}
              onClick={() => onSelect(file, false)}
            >
              {file.name}
              {flag && (
                <span className={read?.unsupported ? 'file-flag-neutral' : 'file-flag'}>
                  {flag}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
