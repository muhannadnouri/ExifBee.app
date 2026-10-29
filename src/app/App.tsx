import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Button } from '../components/atoms/Button';
import { Notice } from '../components/atoms/Notice';
import { Drawer } from '../components/Drawer';
import { Splitter } from '../components/Splitter';
import { FilePane } from '../features/files/FilePane';
import { MetadataInspector } from '../features/metadata/MetadataInspector';
import { ShortcutsDialog } from '../features/help/ShortcutsDialog';
import { SettingsDialog } from '../features/settings/SettingsDialog';
import { ThemeSwitcher } from '../features/settings/ThemeSwitcher';
import { appInfo, exiftoolStatus, isAppError, readSelectedFile } from '../lib/ipc';
import type { AppError, AppInfo, ExifToolStatus, FileMetadata } from '../lib/ipc';
import './App.css';

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

export function App() {
  const [files, setFiles] = useState<FileMetadata[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [failure, setFailure] = useState<AppError | null>(null);
  const [reading, setReading] = useState(false);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [layout, setLayout] = useState(loadLayout);
  const [status, setStatus] = useState('');
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [dependency, setDependency] = useState<ExifToolStatus | null>(null);
  const [warningDismissed, setWarningDismissed] = useState(false);
  const nextLogId = useRef(1);

  useEffect(() => {
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
    } catch {
      // Storage can be unavailable; the layout still works for this session.
    }
  }, [layout]);

  // Startup: check ExifTool and settings once, so problems show before the first read.
  useEffect(() => {
    void appInfo()
      .then((loaded) => {
        setInfo(loaded);
        const warning = loaded.settingsWarning;
        if (warning)
          setLog((entries) => [
            ...entries,
            { id: nextLogId.current++, level: 'warning', message: warning },
          ]);
      })
      .catch(() => undefined);
    void exiftoolStatus()
      .then(setDependency)
      .catch(() => undefined);
  }, []);

  const update = (change: Partial<Layout>) => setLayout((current) => ({ ...current, ...change }));
  const addLog = (level: LogEntry['level'], message: string) =>
    setLog((entries) => [...entries, { id: nextLogId.current++, level, message }]);

  const addFiles = async () => {
    if (reading) return;
    setReading(true);
    setStatus('Reading…');
    try {
      const file = await readSelectedFile();
      if (!file) {
        setStatus('');
        return;
      }
      setFiles((current) => [
        ...current.filter((existing) => existing.sourceFile !== file.sourceFile),
        file,
      ]);
      setSelected(file.sourceFile);
      setFailure(null);
      // Announced politely by the status live region; errors also use role="alert".
      const name = file.sourceFile.split('/').pop() ?? file.sourceFile;
      setStatus(file.error ? `Could not fully read ${name}` : `Read ${name}`);
      if (file.error) addLog('error', `${file.sourceFile}: ${file.error}`);
      else addLog('info', `Read ${file.sourceFile}`);
      for (const warning of file.warnings) addLog('warning', `${file.sourceFile}: ${warning}`);
    } catch (error) {
      const appError = isAppError(error) ? error : { kind: 'Internal', message: String(error) };
      setFailure(appError);
      setStatus('Read failed');
      // A read can fail because ExifTool went missing; refresh the dependency banner.
      void exiftoolStatus()
        .then(setDependency)
        .catch(() => undefined);
      addLog('error', `${appError.kind}: ${appError.message}`);
    } finally {
      setReading(false);
    }
  };

  // Global shortcuts are listed in app/shortcuts.ts; a modal dialog suspends them.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (shortcutsOpen || settingsOpen) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'o') {
        event.preventDefault();
        void addFiles();
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
    <div className="shell" style={style}>
      <header className="toolbar">
        <h1 className="app-name">ExifBee</h1>
        <div role="toolbar" aria-label="Main toolbar" className="toolbar-actions">
          <Button
            onClick={addFiles}
            disabled={reading}
            aria-keyshortcuts="Control+O"
            title="Add files (Ctrl+O)"
          >
            Add files…
          </Button>
          <Button onClick={() => setShortcutsOpen(true)} title="Keyboard shortcuts">
            Shortcuts
          </Button>
          <Button onClick={() => setSettingsOpen(true)}>Settings</Button>
        </div>
        <div className="toolbar-end">
          <span className="status" role="status">
            {status}
          </span>
          <ThemeSwitcher />
        </div>
      </header>

      <div className="workspace">
        <section className="pane files-pane" id="files-pane" aria-labelledby="files-title">
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
          // Tab stop so keyboard users can scroll a long tag table, which has no focusable cells.
          tabIndex={0}
        >
          <h2 id="metadata-title">Metadata</h2>
          {dependency?.error && (
            <Notice
              tone="error"
              actions={<Button onClick={() => setSettingsOpen(true)}>Open settings</Button>}
            >
              ExifTool is not available: {dependency.error.message}
            </Notice>
          )}
          {info?.settingsWarning && !warningDismissed && (
            <Notice
              tone="warning"
              actions={<Button onClick={() => setWarningDismissed(true)}>Dismiss</Button>}
            >
              {info.settingsWarning}
            </Notice>
          )}
          <MetadataInspector file={file} failure={failure} reading={reading} />
        </section>
      </div>

      <div className={`drawers${drawerOpen ? ' drawers-open' : ''}`} id="drawers">
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
          <p className="muted">No staged changes. Metadata editing is not available yet.</p>
        </Drawer>
        <Drawer
          id="log-drawer"
          title="Log"
          open={layout.logOpen}
          onToggle={() => update({ logOpen: !layout.logOpen })}
        >
          {log.length === 0 ? (
            <p className="muted">No activity yet.</p>
          ) : (
            <div role="log" aria-label="Session log">
              {/* Newest first; `reversed` keeps each entry's number as its event order. */}
              <ol className="log" reversed>
                {[...log].reverse().map((entry) => (
                  <li key={entry.id} className={`log-${entry.level}`}>
                    {entry.level}: {entry.message}
                  </li>
                ))}
              </ol>
            </div>
          )}
        </Drawer>
      </div>
      <ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        status={dependency}
        onStatus={setDependency}
        appVersion={info?.version ?? null}
        settingsWarning={warningDismissed ? null : (info?.settingsWarning ?? null)}
      />
    </div>
  );
}
