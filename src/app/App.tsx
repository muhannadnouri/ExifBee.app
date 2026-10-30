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
import { IconButton } from '../components/atoms/IconButton';
import { Icon } from '../components/atoms/Icon';
import { MenuButton } from '../components/MenuButton';
import { AddFolderDialog } from '../features/files/AddFolderDialog';
import { ImportProgress, NO_READS, isRunning, roundResult } from '../features/files/ImportProgress';
import type { ImportRound } from '../features/files/ImportProgress';
import { ErrorNotice } from '../components/ErrorNotice';
import { toAppError } from '../lib/errors';
import {
  addFiles,
  appInfo,
  cancelReads,
  cancelScan,
  exiftoolStatus,
  onFilesDropped,
  onReadProgress,
  onScanProgress,
  pickFolder,
  prioritizeReads,
  readFile,
  scanPickedFolder,
} from '../lib/ipc';
import type {
  AppError,
  AppInfo,
  ExifToolStatus,
  FileMetadata,
  ImportResult,
  ImportedFile,
  ReadSummary,
  ReadUpdate,
  ScanOptions,
  ScanUpdate,
} from '../lib/ipc';
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

const plural = (count: number, one: string, many: string) =>
  `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`;

export function App() {
  const [files, setFiles] = useState<ImportedFile[]>([]);
  // Reads and read failures by file ID; a file is read the first time it is selected.
  const [reads, setReads] = useState<Record<string, FileMetadata>>({});
  const [failures, setFailures] = useState<Record<string, AppError>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importFailure, setImportFailure] = useState<AppError | null>(null);
  const [skipped, setSkipped] = useState<ImportResult | null>(null);
  // The current round of adding files (its scans and checking), shown as the progress card.
  // `roundRef` mirrors it so back-to-back events never build on a stale round.
  const [round, setRound] = useState<ImportRound | null>(null);
  const roundRef = useRef<ImportRound | null>(null);
  const nextRound = useRef(1);
  const [scanOptions, setScanOptionsState] = useState<ScanOptions | null>(null);
  // The folder just chosen for Add folder, awaiting confirmation in the dialog.
  const [folderChoice, setFolderChoice] = useState<string | null>(null);
  // Each opening of the Add folder dialog starts fresh from the session's options.
  const [folderDialogKey, setFolderDialogKey] = useState(0);
  // Scans whose Cancel was clicked, so the button says "Stopping…" until they end.
  const [stopping, setStopping] = useState<number[]>([]);
  // Background read summaries by file ID. The Map is updated in place (setting a key is
  // idempotent, so a repeated updater is harmless) and rewrapped to re-render: copying 200,000
  // entries per update would cost more than the update itself.
  const [summaries, setSummaries] = useState(() => ({ map: new Map<string, ReadSummary>() }));
  const [readStopping, setReadStopping] = useState(false);
  // Session totals from background reads, for the Files header.
  const [tally, setTally] = useState({ errors: 0, warnings: 0, unsupported: 0 });
  const prioritizeTimer = useRef<number | undefined>(undefined);
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

  /** Step one of Add folder: the native dialog in Rust, then the confirm dialog with options. */
  const chooseFolder = async () => {
    if (importing) return;
    setImporting(true);
    try {
      const folder = await pickFolder();
      if (folder !== null) {
        setFolderDialogKey((key) => key + 1);
        setFolderChoice(folder);
      }
    } catch (error) {
      const appError = toAppError(error);
      setImportFailure(appError);
      setStatus('Choosing a folder failed');
      addLog('error', `Add folder: ${appError.kind}: ${appError.message}`);
    } finally {
      setImporting(false);
    }
  };

  /** Step two: scan the confirmed folder with the chosen options (they become the session's). */
  const addFolder = async (options: ScanOptions) => {
    const folder = folderChoice;
    setFolderChoice(null);
    setScanOptionsState(options);
    try {
      await scanPickedFolder(options);
      setStatus(`Adding ${folder ?? 'folder'}…`);
    } catch (error) {
      const appError = toAppError(error);
      setImportFailure(appError);
      setStatus('Adding a folder failed');
      addLog('error', `Add folder: ${appError.kind}: ${appError.message}`);
    }
  };

  /** Moves the progress card to `next`; when that ends the round, announces and logs its result
   * once and resets the Cancel state. */
  const commitRound = (next: ImportRound) => {
    const before = roundRef.current;
    roundRef.current = next;
    setRound(next);
    const ended = !isRunning(next) && (!before || before.id !== next.id || isRunning(before));
    if (!ended) return;
    const { tone, text } = roundResult(next);
    setStatus(text);
    addLog(tone, text);
    setStopping([]);
    setReadStopping(false);
  };

  /** The round an update belongs to: the current one while it runs, otherwise a new one. */
  const roundFor = () => {
    const current = roundRef.current;
    return current && isRunning(current)
      ? current
      : { id: nextRound.current++, scans: [], reads: null, readsBefore: NO_READS };
  };

  /** Lists a scan's new files as they arrive and logs every skipped item. */
  const handleScan = (update: ScanUpdate) => {
    setFiles((current) => [...current, ...update.added]);
    const base = roundFor();
    commitRound({
      ...base,
      scans: base.scans.some((scan) => scan.scanId === update.scanId)
        ? base.scans.map((scan) => (scan.scanId === update.scanId ? update : scan))
        : [...base.scans, update],
    });
    if (update.state !== 'Running')
      setStopping((current) => current.filter((id) => id !== update.scanId));
    for (const { path, reason } of update.problems)
      addLog('warning', `Skipped: ${path}: ${reason}`);
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

  /** Records each file's summary, keeps the progress card and totals current, and logs real
   * errors (an unsupported format is expected, so it is counted, not logged per file). */
  const handleRead = (update: ReadUpdate) => {
    setSummaries(({ map }) => {
      for (const result of update.results) map.set(result.id, result);
      return { map };
    });
    if (update.results.length > 0)
      setTally((current) => {
        const next = { ...current };
        for (const result of update.results) {
          if (result.unsupported) next.unsupported++;
          else if (result.error) next.errors++;
          if (result.warnings.length > 0) next.warnings++;
        }
        return next;
      });
    const base = roundFor();
    // A new read run within a running round (a scan queued more files after the last one ended)
    // adds to the round's totals instead of restarting them.
    const previous = base.reads && base.reads.state !== 'Running' ? base.reads.counts : null;
    commitRound({
      ...base,
      reads: update,
      readsBefore: previous
        ? {
            done: base.readsBefore.done + previous.done,
            total: base.readsBefore.total + previous.total,
            errors: base.readsBefore.errors + previous.errors,
            warnings: base.readsBefore.warnings + previous.warnings,
            unsupported: base.readsBefore.unsupported + previous.unsupported,
          }
        : base.readsBefore,
    });
    const failed = update.results.filter((result) => result.error && !result.unsupported);
    if (failed.length > 0) {
      const paths = new Map(files.map((file) => [file.id, file.path]));
      for (const { id, error } of failed) addLog('error', `${paths.get(id) ?? id}: ${error}`);
    }
  };

  const stopReading = () => {
    setReadStopping(true);
    void cancelReads().catch((error: unknown) => {
      setReadStopping(false);
      const { kind, message } = toAppError(error);
      addLog('error', `Stop checking files: ${kind}: ${message}`);
    });
  };

  /** One Cancel for adding files: stops the round's running scans and the background reads.
   * Files already listed stay; selecting one still reads it. */
  const cancelRound = () => {
    const current = roundRef.current;
    if (!current) return;
    for (const scan of current.scans)
      if (scan.state === 'Running' && !stopping.includes(scan.scanId)) stopScan(scan.scanId);
    if (current.reads?.state === 'Running' && !readStopping) stopReading();
  };

  /** Rows in view are checked next; debounced, so scrolling sends one request, not dozens. */
  const prioritizeVisible = (ids: string[]) => {
    window.clearTimeout(prioritizeTimer.current);
    if (roundRef.current?.reads?.state !== 'Running') return;
    prioritizeTimer.current = window.setTimeout(
      () =>
        void prioritizeReads(ids).catch((error: unknown) => {
          const { kind, message } = toAppError(error);
          addLog('error', `Check visible files first: ${kind}: ${message}`);
        }),
      150,
    );
  };

  /** Clicks inspect at once; arrowing waits until the selection rests, so holding a key does not
   * start an ExifTool read for every file passed. */
  const selectFile = (entry: ImportedFile, fromKeyboard: boolean) => {
    window.clearTimeout(keyboardRead.current);
    if (!fromKeyboard) return void inspect(entry);
    setSelected(entry.id);
    keyboardRead.current = window.setTimeout(() => void inspect(entry), 200);
  };

  // Drops and scans happen in Rust; only their results arrive here (DEC-020, DEC-021).
  const onDrop = useEffectEvent(handleImport);
  const onScan = useEffectEvent(handleScan);
  const onRead = useEffectEvent(handleRead);
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
      onReadProgress((update) => onRead(update)).catch(failed('Metadata reads')),
    ];
    return () => stops.forEach((stop) => void stop.then((unlisten) => unlisten?.()));
  }, []);

  // Global shortcuts are listed in app/shortcuts.ts; a modal dialog suspends them.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (shortcutsOpen || settingsOpen || folderChoice !== null) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'o') {
        event.preventDefault();
        void (event.shiftKey ? chooseFolder() : chooseFiles());
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
          <MenuButton
            disabled={importing}
            items={[
              { label: 'Files…', shortcut: 'Ctrl+O', onSelect: () => void chooseFiles() },
              { label: 'Folder…', shortcut: 'Ctrl+Shift+O', onSelect: () => void chooseFolder() },
            ]}
          >
            <Icon name="plus" />
            Add
          </MenuButton>
          <div className="toolbar-end">
            <ThemeSwitcher />
            <IconButton
              icon="help"
              label="Keyboard shortcuts"
              onClick={() => setShortcutsOpen(true)}
            />
            <IconButton icon="settings" label="Settings" onClick={() => setSettingsOpen(true)} />
          </div>
        </div>
        {/* Announces starts and results; visible progress lives in the files pane. */}
        <span className="visually-hidden" role="status">
          {status}
        </span>
      </header>

      <div className="workspace">
        <section className="pane files-pane" id="files-pane" aria-labelledby="files-title">
          <h2 id="files-title">Files</h2>
          {files.length > 0 && (
            <p className="files-totals muted">
              {[
                plural(files.length, 'file', 'files'),
                tally.errors > 0 && plural(tally.errors, 'with errors', 'with errors'),
                tally.warnings > 0 && plural(tally.warnings, 'with warnings', 'with warnings'),
                tally.unsupported > 0 && plural(tally.unsupported, 'unsupported', 'unsupported'),
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          )}
          {round && (
            <ImportProgress
              key={round.id}
              round={round}
              stopping={readStopping || stopping.length > 0}
              onCancel={cancelRound}
              onDismiss={() => {
                roundRef.current = null;
                setRound(null);
              }}
            />
          )}
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
            summaries={summaries.map}
            failures={failures}
            onVisibleChange={prioritizeVisible}
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
              <ol
                className="log"
                reversed
                style={{ '--log-digits': String(log.length).length } as CSSProperties}
              >
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
      {scanOptions && (
        <AddFolderDialog
          key={folderDialogKey}
          folder={folderChoice}
          options={scanOptions}
          onChooseAgain={() =>
            void pickFolder()
              .then((folder) => folder !== null && setFolderChoice(folder))
              .catch((error: unknown) => {
                const { kind, message } = toAppError(error);
                addLog('error', `Add folder: ${kind}: ${message}`);
              })
          }
          onAdd={(options) => void addFolder(options)}
          onClose={() => setFolderChoice(null)}
        />
      )}
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
