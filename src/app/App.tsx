import { useEffect, useEffectEvent, useRef, useState } from 'react';
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
import { ErrorNotice } from '../components/ErrorNotice';
import { toAppError } from '../lib/errors';
import {
  addFiles,
  addFolder,
  appInfo,
  cancelScan,
  exiftoolStatus,
  onFilesDropped,
  onScanProgress,
  readFile,
  setScanOptions,
} from '../lib/ipc';
import type {
  AppError,
  AppInfo,
  ExifToolStatus,
  FileMetadata,
  ImportResult,
  ImportedFile,
  ScanOptions,
  ScanUpdate,
} from '../lib/ipc';
import { ScanOptionsForm } from '../features/files/ScanOptionsForm';
import { ScanStatus, scanSummary } from '../features/files/ScanStatus';
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

/** When the status check itself fails, the banner still explains why instead of staying silent. */
const statusFailure = (error: unknown): ExifToolStatus => ({
  isOverride: false,
  path: null,
  resolvedPath: null,
  version: null,
  minimumVersion: '',
  error: toAppError(error),
});

type LogEntry = { id: number; level: 'info' | 'warning' | 'error'; message: string };

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export function App() {
  const [files, setFiles] = useState<ImportedFile[]>([]);
  // Reads and read failures by file ID; a file is read the first time it is selected.
  const [reads, setReads] = useState<Record<string, FileMetadata>>({});
  const [failures, setFailures] = useState<Record<string, AppError>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importFailure, setImportFailure] = useState<AppError | null>(null);
  const [skipped, setSkipped] = useState<ImportResult | null>(null);
  // Latest update of each scan shown in the files pane, in start order.
  const [scans, setScans] = useState<ScanUpdate[]>([]);
  const [scanOptions, setScanOptionsState] = useState<ScanOptions | null>(null);
  // Scans whose Stop was clicked, so the button says "Stopping…" until the final update.
  const [stopping, setStopping] = useState<number[]>([]);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [layout, setLayout] = useState(loadLayout);
  const [status, setStatus] = useState('');
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [dependency, setDependency] = useState<ExifToolStatus | null>(null);
  const [warningDismissed, setWarningDismissed] = useState(false);
  const nextLogId = useRef(1);
  const readsInFlight = useRef(new Set<string>());
  const keyboardRead = useRef<number | undefined>(undefined);

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
        setScanOptionsState(loaded.scanOptions);
        const warning = loaded.settingsWarning;
        if (warning)
          setLog((entries) => [
            ...entries,
            { id: nextLogId.current++, level: 'warning', message: warning },
          ]);
      })
      .catch((error: unknown) => {
        const { kind, message } = toAppError(error);
        setLog((entries) => [
          ...entries,
          { id: nextLogId.current++, level: 'error', message: `App info: ${kind}: ${message}` },
        ]);
      });
    void exiftoolStatus()
      .then(setDependency)
      .catch((error: unknown) => setDependency(statusFailure(error)));
  }, []);

  const update = (change: Partial<Layout>) => setLayout((current) => ({ ...current, ...change }));
  const addLog = (level: LogEntry['level'], message: string) =>
    setLog((entries) => [...entries, { id: nextLogId.current++, level, message }]);

  const refreshDependency = () =>
    void exiftoolStatus()
      .then(setDependency)
      .catch((error: unknown) => setDependency(statusFailure(error)));

  /** Selects a file and reads it unless it was already read; a failed read is retried. */
  const inspect = async ({ id, path, name }: ImportedFile) => {
    setSelected(id);
    if (reads[id] || readsInFlight.current.has(id)) return;
    readsInFlight.current.add(id);
    setFailures((current) =>
      Object.fromEntries(Object.entries(current).filter(([failed]) => failed !== id)),
    );
    // Announced politely by the status live region; errors also use role="alert".
    setStatus(`Reading ${name}…`);
    try {
      const read = await readFile(id);
      setReads((current) => ({ ...current, [id]: read }));
      setStatus(read.error ? `Could not fully read ${name}` : `Read ${name}`);
      if (read.error) addLog('error', `${path}: ${read.error}`);
      else addLog('info', `Read ${path}`);
      for (const warning of read.warnings) addLog('warning', `${path}: ${warning}`);
    } catch (error) {
      const appError = toAppError(error);
      setFailures((current) => ({ ...current, [id]: appError }));
      setStatus(`Could not read ${name}`);
      // A read can fail because ExifTool went missing; refresh the dependency banner.
      refreshDependency();
      addLog('error', `${path}: ${appError.kind}: ${appError.message}`);
    } finally {
      readsInFlight.current.delete(id);
    }
  };

  /** Shows what one dialog selection or drop added, skipped and refused; inspects the first new file. */
  const handleImport = (result: ImportResult) => {
    const { added, duplicates, rejected } = result;
    setFiles((current) => [...current, ...added]);
    setImportFailure(null);
    setSkipped(duplicates.length + rejected.length > 0 ? result : null);
    if (added.length > 0) addLog('info', `Added ${plural(added.length, 'file', 'files')}`);
    for (const path of duplicates) addLog('warning', `Already in the list, skipped: ${path}`);
    for (const { path, reason } of rejected) addLog('warning', `Not added: ${path}: ${reason}`);
    const [first] = added;
    if (first) void inspect(first);
    else setStatus('No files added');
  };

  const chooseFiles = async () => {
    if (importing) return;
    setImporting(true);
    try {
      const result = await addFiles();
      if (result) handleImport(result);
    } catch (error) {
      const appError = toAppError(error);
      setImportFailure(appError);
      setStatus('Adding files failed');
      addLog('error', `Add files: ${appError.kind}: ${appError.message}`);
    } finally {
      setImporting(false);
    }
  };

  const chooseFolder = async () => {
    if (importing) return;
    setImporting(true);
    try {
      if ((await addFolder()) !== null) setStatus('Scanning folder…');
    } catch (error) {
      const appError = toAppError(error);
      setImportFailure(appError);
      setStatus('Adding a folder failed');
      addLog('error', `Add folder: ${appError.kind}: ${appError.message}`);
    } finally {
      setImporting(false);
    }
  };

  /** Lists a scan's new files as they arrive and logs every skipped item and the end state. */
  const handleScan = (update: ScanUpdate) => {
    setFiles((current) => [...current, ...update.added]);
    setScans((current) =>
      current.some((scan) => scan.scanId === update.scanId)
        ? current.map((scan) => (scan.scanId === update.scanId ? update : scan))
        : [...current, update],
    );
    for (const { path, reason } of update.problems)
      addLog('warning', `Skipped: ${path}: ${reason}`);
    if (update.state !== 'Running') {
      const summary = scanSummary(update);
      setStatus(summary);
      addLog(
        update.state === 'Complete' ? 'info' : update.state === 'Failed' ? 'error' : 'warning',
        summary,
      );
    }
    const [first] = update.added;
    if (first && selected === null) void inspect(first);
  };

  // Acknowledged at once (NN/g: feedback within 0.1 s); the scan ends with its final update.
  const stopScan = (scanId: number) => {
    setStopping((current) => [...current, scanId]);
    void cancelScan(scanId).catch((error: unknown) => {
      setStopping((current) => current.filter((id) => id !== scanId));
      const { kind, message } = toAppError(error);
      addLog('error', `Stop scan: ${kind}: ${message}`);
    });
  };

  /** Clicks inspect at once; arrowing waits until the selection rests, so holding a key does not
   * start an ExifTool read for every file passed. */
  const selectFile = (entry: ImportedFile, fromKeyboard: boolean) => {
    window.clearTimeout(keyboardRead.current);
    if (!fromKeyboard) return void inspect(entry);
    setSelected(entry.id);
    keyboardRead.current = window.setTimeout(() => void inspect(entry), 200);
  };

  const changeScanOptions = (next: ScanOptions) =>
    void setScanOptions(next)
      .then(setScanOptionsState)
      .catch((error: unknown) => {
        const { kind, message } = toAppError(error);
        addLog('error', `Folder options were not changed: ${kind}: ${message}`);
      });

  // Drops and scans happen in Rust; only their results arrive here (DEC-020, DEC-021).
  const onDrop = useEffectEvent(handleImport);
  const onScan = useEffectEvent(handleScan);
  useEffect(() => {
    const failed = (source: string) => (error: unknown) => {
      const { kind, message } = toAppError(error);
      setLog((entries) => [
        ...entries,
        { id: nextLogId.current++, level: 'error', message: `${source}: ${kind}: ${message}` },
      ]);
    };
    const stops = [
      onFilesDropped((result) => onDrop(result)).catch(failed('Drag and drop')),
      onScanProgress((update) => onScan(update)).catch(failed('Folder scans')),
    ];
    return () => stops.forEach((stop) => void stop.then((unlisten) => unlisten?.()));
  }, []);

  // Global shortcuts are listed in app/shortcuts.ts; a modal dialog suspends them.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (shortcutsOpen || settingsOpen) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'o') {
        event.preventDefault();
        void chooseFiles();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  const drawerOpen = layout.actionsOpen || layout.logOpen;
  const file = selected ? (reads[selected] ?? null) : null;
  const failure = selected ? (failures[selected] ?? null) : null;
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
            onClick={chooseFiles}
            disabled={importing}
            aria-keyshortcuts="Control+O"
            title="Add files (Ctrl+O)"
          >
            Add files…
          </Button>
          <Button onClick={chooseFolder} disabled={importing}>
            Add folder…
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
          {scanOptions && <ScanOptionsForm options={scanOptions} onChange={changeScanOptions} />}
          {scans.map((scan) => (
            <ScanStatus
              key={scan.scanId}
              scan={scan}
              stopping={stopping.includes(scan.scanId)}
              onStop={() => stopScan(scan.scanId)}
              onDismiss={() =>
                setScans((current) => current.filter((other) => other.scanId !== scan.scanId))
              }
            />
          ))}
          {importFailure && <ErrorNotice error={importFailure} />}
          {skipped && (
            <Notice
              tone="warning"
              actions={<Button onClick={() => setSkipped(null)}>Dismiss</Button>}
            >
              {skipped.duplicates.length > 0 &&
                `Skipped ${plural(skipped.duplicates.length, 'file', 'files')} already in the list. `}
              {skipped.rejected.length > 0 &&
                `${plural(skipped.rejected.length, 'item was', 'items were')} not added. `}
              The Log lists each one.
            </Notice>
          )}
          <FilePane
            files={files}
            reads={reads}
            failures={failures}
            selected={selected}
            onSelect={selectFile}
          />
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
            <ErrorNotice
              error={dependency.error}
              actions={<Button onClick={() => setSettingsOpen(true)}>Open settings</Button>}
            />
          )}
          {info?.settingsWarning && !warningDismissed && (
            <Notice
              tone="warning"
              actions={<Button onClick={() => setWarningDismissed(true)}>Dismiss</Button>}
            >
              {info.settingsWarning}
            </Notice>
          )}
          <MetadataInspector file={file} failure={failure} reading={selected !== null} />
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
