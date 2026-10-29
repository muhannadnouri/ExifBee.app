import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { Splitter } from '../components/Splitter';
import { FilePane } from '../features/files/FilePane';
import { MetadataInspector } from '../features/metadata/MetadataInspector';
import { isAppError, readSelectedFile } from '../lib/ipc';
import type { AppError, FileMetadata } from '../lib/ipc';

export type Layout = {
  filesWidth: number;
  drawerHeight: number;
  actionsOpen: boolean;
  logOpen: boolean;
};

export const LAYOUT_KEY = 'exifbee.layout';
export const DEFAULT_LAYOUT: Layout = {
  filesWidth: 280,
  drawerHeight: 200,
  actionsOpen: false,
  logOpen: false,
};
export const FILES_WIDTH = { min: 160, max: 640 };
export const DRAWER_HEIGHT = { min: 96, max: 480 };

// Pane sizes are a per-machine UI convenience; app settings get a real config file in S1-T04.
export function loadLayout(): Layout {
  let saved: Partial<Record<keyof Layout, unknown>> = {};
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? '{}');
    if (parsed && typeof parsed === 'object') saved = parsed;
  } catch {
    // Unreadable or corrupt storage falls back to defaults.
  }
  const size = (value: unknown, fallback: number, range: { min: number; max: number }) =>
    typeof value === 'number' && Number.isFinite(value)
      ? Math.min(range.max, Math.max(range.min, value))
      : fallback;
  const flag = (value: unknown, fallback: boolean) =>
    typeof value === 'boolean' ? value : fallback;
  return {
    filesWidth: size(saved.filesWidth, DEFAULT_LAYOUT.filesWidth, FILES_WIDTH),
    drawerHeight: size(saved.drawerHeight, DEFAULT_LAYOUT.drawerHeight, DRAWER_HEIGHT),
    actionsOpen: flag(saved.actionsOpen, DEFAULT_LAYOUT.actionsOpen),
    logOpen: flag(saved.logOpen, DEFAULT_LAYOUT.logOpen),
  };
}

type LogEntry = { id: number; level: 'info' | 'warning' | 'error'; message: string };

function Drawer(props: {
  id: string;
  title: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <section className="drawer" aria-labelledby={`${props.id}-title`}>
      <h2 className="drawer-header" id={`${props.id}-title`}>
        <button
          type="button"
          aria-expanded={props.open}
          aria-controls={props.id}
          onClick={props.onToggle}
        >
          {props.open ? '▾' : '▸'} {props.title}
        </button>
      </h2>
      {props.open && (
        <div className="drawer-body" id={props.id}>
          {props.children}
        </div>
      )}
    </section>
  );
}

export function App() {
  const [files, setFiles] = useState<FileMetadata[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [failure, setFailure] = useState<AppError | null>(null);
  const [reading, setReading] = useState(false);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [layout, setLayout] = useState(loadLayout);
  const shell = useRef<HTMLDivElement>(null);
  const nextLogId = useRef(1);

  useEffect(() => {
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
    } catch {
      // Storage can be unavailable; the layout still works for this session.
    }
  }, [layout]);

  const update = (change: Partial<Layout>) => setLayout((current) => ({ ...current, ...change }));
  const addLog = (level: LogEntry['level'], message: string) =>
    setLog((entries) => [...entries, { id: nextLogId.current++, level, message }]);

  const addFiles = async () => {
    if (reading) return;
    setReading(true);
    try {
      const file = await readSelectedFile();
      if (!file) return;
      setFiles((current) => [
        ...current.filter((existing) => existing.sourceFile !== file.sourceFile),
        file,
      ]);
      setSelected(file.sourceFile);
      setFailure(null);
      if (file.error) addLog('error', `${file.sourceFile}: ${file.error}`);
      else addLog('info', `Read ${file.sourceFile}`);
      for (const warning of file.warnings) addLog('warning', `${file.sourceFile}: ${warning}`);
    } catch (error) {
      const appError = isAppError(error) ? error : { kind: 'Internal', message: String(error) };
      setFailure(appError);
      addLog('error', `${appError.kind}: ${appError.message}`);
    } finally {
      setReading(false);
    }
  };

  // Ctrl+O adds files; F6 / Shift+F6 cycle focus through the toolbar, panes and open drawers.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'o') {
        event.preventDefault();
        void addFiles();
      } else if (event.key === 'F6' && shell.current) {
        event.preventDefault();
        const regions = [...shell.current.querySelectorAll<HTMLElement>('[data-region]')];
        const current = regions.findIndex((region) => region.contains(document.activeElement));
        const step = event.shiftKey ? -1 : 1;
        const next = regions[(current + step + regions.length) % regions.length];
        (next?.querySelector<HTMLElement>('button') ?? next)?.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  const drawerOpen = layout.actionsOpen || layout.logOpen;
  const file = files.find((candidate) => candidate.sourceFile === selected) ?? null;
  const style = {
    '--files-width': `${layout.filesWidth}px`,
    '--drawer-height': `${layout.drawerHeight}px`,
  } as CSSProperties;

  return (
    <div className="shell" ref={shell} style={style}>
      <header className="toolbar" data-region>
        <h1 className="app-name">ExifBee</h1>
        <div role="toolbar" aria-label="Main toolbar" className="toolbar-actions">
          <button
            type="button"
            onClick={addFiles}
            disabled={reading}
            aria-keyshortcuts="Control+O"
            title="Add files (Ctrl+O)"
          >
            Add files…
          </button>
        </div>
        <span className="status" role="status">
          {reading ? 'Reading…' : ''}
        </span>
      </header>

      <div className="workspace">
        <section
          className="pane files-pane"
          id="files-pane"
          aria-labelledby="files-title"
          tabIndex={-1}
          data-region
        >
          <h2 id="files-title">Files</h2>
          <FilePane files={files} selected={selected} onSelect={setSelected} />
        </section>
        <Splitter
          label="Resize files pane"
          orientation="vertical"
          controls="files-pane"
          value={layout.filesWidth}
          {...FILES_WIDTH}
          onChange={(filesWidth) => update({ filesWidth })}
        />
        <section
          className="pane metadata-pane"
          aria-labelledby="metadata-title"
          tabIndex={-1}
          data-region
        >
          <h2 id="metadata-title">Metadata</h2>
          <MetadataInspector file={file} failure={failure} reading={reading} />
        </section>
      </div>

      <div className={`drawers${drawerOpen ? ' drawers-open' : ''}`} id="drawers" data-region>
        {drawerOpen && (
          <Splitter
            label="Resize drawers"
            orientation="horizontal"
            controls="drawers"
            value={layout.drawerHeight}
            {...DRAWER_HEIGHT}
            onChange={(drawerHeight) => update({ drawerHeight })}
          />
        )}
        <Drawer
          id="actions-drawer"
          title="Actions"
          open={layout.actionsOpen}
          onToggle={() => update({ actionsOpen: !layout.actionsOpen })}
        >
          <p className="empty">No staged changes. Metadata editing is not available yet.</p>
        </Drawer>
        <Drawer
          id="log-drawer"
          title="Log"
          open={layout.logOpen}
          onToggle={() => update({ logOpen: !layout.logOpen })}
        >
          {log.length === 0 ? (
            <p className="empty">No activity yet.</p>
          ) : (
            <ol className="log" role="log" aria-label="Session log">
              {log.map((entry) => (
                <li key={entry.id} className={`log-${entry.level}`}>
                  {entry.level}: {entry.message}
                </li>
              ))}
            </ol>
          )}
        </Drawer>
      </div>
    </div>
  );
}
