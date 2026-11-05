import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { IconButton } from '../../components/atoms/IconButton';
import type { TagEntry, Writability } from '../../lib/ipc';
import { MetadataValueView } from './MetadataValueView';
import { valueText } from './tagFilter';
import './TagRows.css';

type Props = {
  rows: TagEntry[];
  onCopy: (content: string, what: string) => void;
};

const WRITABILITY: Record<Writability, { label: string; hint: string }> = {
  writable: { label: 'Writable', hint: 'The installed ExifTool can write this tag in this file.' },
  readOnly: {
    label: 'Read-only',
    hint: 'This tag or file format is not writable through the selected ExifTool version.',
  },
  unknown: { label: 'Unknown', hint: 'Write support could not be confirmed.' },
};

/** Height assumed for rows before any is measured; then the first rows' average, kept fixed. */
const ESTIMATE = 34;
/** Rows drawn beyond the visible part, in pixels, so scrolling rarely shows a gap. */
const OVERSCAN = 600;

/**
 * The tag table's body, drawing only the rows near the visible part of the metadata pane
 * (S3-T05, DEC-025). Rows wrap (lists, structures, long values), so heights are measured and
 * cached by tag key; spacer rows stand in for the rest.
 *
 * Gotchas:
 * - Scroll stability: when a row starting above the view is measured at a different height than
 *   assumed, the pane's scroll position moves by the difference, so what is on screen stays put.
 *   The browser's own scroll anchoring is off for the pane (Chromium has it, WebKitGTK may not),
 *   so this correction is the only one and behaves the same in both.
 * - Focus: the row holding focus (e.g. its Copy button) is always drawn, even when scrolled far
 *   away, so focus is never dropped to the page; spacers fill the gaps around it.
 * - The scroll container is the enclosing `.pane`; without one (tests) everything is drawn.
 */
export function TagRows({ rows, onCopy }: Props) {
  const body = useRef<HTMLTableSectionElement>(null);
  // Measured heights by tag key: one Map for the component's life, filled in by the layout
  // effect; `measured` counts fills so a render follows each.
  const [heights] = useState(() => new Map<string, number>());
  const [measured, setMeasured] = useState(0);
  // The visible band in body coordinates; until measured, assume the top of a tall window.
  const [band, setBand] = useState({ top: 0, height: 1200 });
  const [focused, setFocused] = useState<string | null>(null);
  // Whether the pane was scrolled to the end before the last redraw: then it stays at the end
  // while rows there get measured, instead of drifting off it.
  // `top` is where it was then: if the scroll position has moved since (the user scrolled and
  // the event is not delivered yet), it is not pinned.
  const atEnd = useRef({ pinned: false, top: 0 });
  const lostFraction = useRef(0);

  useEffect(() => {
    const scroller = body.current?.closest<HTMLElement>('.pane');
    if (!body.current || !scroller) return;
    const update = () => {
      atEnd.current = {
        pinned: scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2,
        top: scroller.scrollTop,
      };
      const top =
        scroller.getBoundingClientRect().top - (body.current?.getBoundingClientRect().top ?? 0);
      setBand({ top, height: scroller.clientHeight || 1200 });
    };
    scroller.addEventListener('scroll', update, { passive: true });
    // Also delivers the first measurement: observers report once when they start.
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    resize?.observe(scroller);
    return () => {
      scroller.removeEventListener('scroll', update);
      resize?.disconnect();
    };
  }, []);

  // Rows not yet drawn are assumed as tall as the first rows drawn, on average. The estimate is
  // set once: re-averaging later would resize the spacer standing in for thousands of rows above
  // the view and move everything on screen.
  const [learned, setLearned] = useState<number | null>(null);
  const estimate = learned ?? ESTIMATE;

  // Measure what was drawn; correct the scroll position for rows starting above the view.
  useLayoutEffect(() => {
    const scroller = body.current?.closest<HTMLElement>('.pane');
    const scrollerTop = scroller?.getBoundingClientRect().top ?? 0;
    let changed = false;
    let shift = 0;
    for (const row of body.current?.querySelectorAll<HTMLElement>('tr[data-key]') ?? []) {
      const key = row.dataset.key ?? '';
      const rect = row.getBoundingClientRect();
      const before = heights.get(key) ?? estimate;
      if (rect.height <= 0 || Math.abs(rect.height - before) < 0.5) continue;
      heights.set(key, rect.height);
      changed = true;
      // A row starting above the view pushes what is on screen by its change in height.
      if (rect.top < scrollerTop) shift += rect.height - before;
    }
    const pinned =
      atEnd.current.pinned && Math.abs((scroller?.scrollTop ?? 0) - atEnd.current.top) < 1;
    if (scroller && changed && pinned) scroller.scrollTop = scroller.scrollHeight;
    else if (scroller && shift !== 0) {
      // The browser snaps scrollTop to whole pixels; carry the rest so errors do not add up.
      const wanted = scroller.scrollTop + shift + lostFraction.current;
      scroller.scrollTop = wanted;
      lostFraction.current = wanted - scroller.scrollTop;
    }
    // Measuring layout and redrawing with it is this effect's purpose; it stops once nothing
    // changes, which happens after one pass for the rows drawn.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (changed) setMeasured((count) => count + 1);
    if (learned === null && heights.size > 0) {
      let sum = 0;
      for (const height of heights.values()) sum += height;
      setLearned(sum / heights.size);
    }
  }, [rows, band, measured, heights, estimate, learned]);

  // Row start offsets: O(rows) per render, cheap next to drawing even one row.
  const starts = new Array<number>(rows.length);
  let total = 0;
  rows.forEach((tag, index) => {
    starts[index] = total;
    total += heights.get(tag.key) ?? estimate;
  });
  const end = (index: number) =>
    (starts[index] ?? 0) + (heights.get(rows[index]?.key ?? '') ?? estimate);
  let first = 0;
  while (first < rows.length - 1 && end(first) < band.top - OVERSCAN) first++;
  let last = first;
  while (last < rows.length - 1 && (starts[last + 1] ?? 0) < band.top + band.height + OVERSCAN)
    last++;

  const drawn = new Set<number>();
  for (let index = first; index <= last && index < rows.length; index++) drawn.add(index);
  const focusIndex = focused === null ? -1 : rows.findIndex((tag) => tag.key === focused);
  // The focused row and its neighbours stay drawn, so focus is never dropped and Tab or
  // Shift+Tab from it reaches the next or previous tag, not whatever row happens to be drawn.
  if (focusIndex >= 0)
    for (const index of [focusIndex - 1, focusIndex, focusIndex + 1])
      if (index >= 0 && index < rows.length) drawn.add(index);
  const indexes = [...drawn].sort((a, b) => a - b);

  const parts: ReactNode[] = [];
  let next = 0;
  for (const index of indexes) {
    if (index > next)
      parts.push(
        <Spacer key={`gap-${next}`} height={(starts[index] ?? 0) - (starts[next] ?? 0)} />,
      );
    const tag = rows[index];
    if (tag) parts.push(<TagRow key={tag.key} tag={tag} index={index} onCopy={onCopy} />);
    next = index + 1;
  }
  if (next < rows.length)
    parts.push(<Spacer key={`gap-${next}`} height={total - (starts[next] ?? 0)} />);

  return (
    <tbody
      ref={body}
      onFocus={(event) =>
        setFocused((event.target as HTMLElement).closest('tr')?.dataset.key ?? null)
      }
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(null);
      }}
    >
      {parts}
    </tbody>
  );
}

function Spacer({ height }: { height: number }) {
  return (
    <tr className="tags-spacer" aria-hidden="true">
      <td colSpan={5} style={{ height }} />
    </tr>
  );
}

/** One tag; memoized, since a scroll redraws the body but rarely changes a drawn row. */
const TagRow = memo(function TagRow({
  tag,
  index,
  onCopy,
}: {
  tag: TagEntry;
  index: number;
  onCopy: Props['onCopy'];
}) {
  const { label, hint } = WRITABILITY[tag.writable];
  return (
    // Row 1 is the header, so tag rows are numbered from 2 for screen readers.
    <tr data-key={tag.key} aria-rowindex={index + 2}>
      <td className="tags-group">
        {tag.group1}
        {tag.copy !== null && ` · copy ${tag.copy}`}
      </td>
      {/* The row header names the tag fully, so same-name tags in other groups stay distinct. */}
      {/* An explicit name: a hidden group prefix made browsers insert a space ("IFD0: Make"). */}
      <th scope="row" aria-label={tag.key}>
        {tag.name}
      </th>
      <td>
        <MetadataValueView value={tag.value} />
      </td>
      <td>
        <span className={`writability writability-${tag.writable}`} title={hint}>
          {label}
        </span>
      </td>
      <td>
        <IconButton
          icon="copy"
          label={`Copy value of ${tag.key}`}
          onClick={() => onCopy(valueText(tag.value), `the value of ${tag.key}`)}
        />
      </td>
    </tr>
  );
});
