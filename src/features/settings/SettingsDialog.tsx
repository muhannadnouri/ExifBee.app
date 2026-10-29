import { useState } from 'react';
import { Button } from '../../components/atoms/Button';
import { Notice } from '../../components/atoms/Notice';
import { Dialog } from '../../components/Dialog';
import { ErrorNotice } from '../../components/ErrorNotice';
import { toAppError } from '../../lib/errors';
import { chooseExiftoolOverride, exiftoolStatus, resetExiftoolOverride } from '../../lib/ipc';
import type { AppError, ExifToolStatus } from '../../lib/ipc';
import './SettingsDialog.css';

type Props = {
  open: boolean;
  onClose: () => void;
  status: ExifToolStatus | null;
  onStatus: (status: ExifToolStatus) => void;
  appVersion: string | null;
  settingsWarning: string | null;
};

// Linux uses the system ExifTool (SPEC §3.1); these are the common package names.
const INSTALL_HINTS = [
  { distro: 'Debian / Ubuntu', command: 'sudo apt install libimage-exiftool-perl' },
  { distro: 'Fedora', command: 'sudo dnf install perl-Image-ExifTool' },
  { distro: 'Arch / CachyOS / Manjaro', command: 'sudo pacman -S perl-image-exiftool' },
];

export function SettingsDialog({
  open,
  onClose,
  status,
  onStatus,
  appVersion,
  settingsWarning,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failure, setFailure] = useState<AppError | null>(null);

  const run = async (action: () => Promise<ExifToolStatus | null>, rejected?: string) => {
    setBusy(true);
    setMessage(null);
    setFailure(null);
    try {
      const next = await action();
      if (!next) return;
      // A chosen executable that fails validation is not saved; say so plainly.
      if (rejected && next.error) {
        setFailure({ kind: next.error.kind, message: `${rejected} ${next.error.message}` });
        return;
      }
      onStatus(next);
      setMessage(next.error ? null : `Using ExifTool ${next.version ?? ''} at ${next.path ?? ''}.`);
    } catch (error) {
      setFailure(toAppError(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog id="settings" title="Settings" open={open} onClose={onClose}>
      <div className="settings">
        {settingsWarning && <Notice tone="warning">{settingsWarning}</Notice>}

        <section aria-labelledby="settings-exiftool">
          <h3 id="settings-exiftool">ExifTool</h3>
          {!status ? (
            <p className="muted">Checking…</p>
          ) : status.error ? (
            <>
              <ErrorNotice error={status.error} />
              {(status.error.kind === 'DependencyMissing' ||
                status.error.kind === 'Unsupported') && (
                <>
                  <p>
                    ExifBee uses the ExifTool installed on your system (version{' '}
                    {status.minimumVersion} or newer). Install it with your package manager, then
                    choose Retry:
                  </p>
                  <table className="settings-hints">
                    <tbody>
                      {INSTALL_HINTS.map(({ distro, command }) => (
                        <tr key={distro}>
                          <th scope="row">{distro}</th>
                          <td>
                            <code>{command}</code>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </>
          ) : (
            <dl className="settings-facts">
              <dt>Version</dt>
              <dd>{status.version}</dd>
              <dt>Executable</dt>
              <dd>{status.path}</dd>
              {status.resolvedPath && (
                <>
                  <dt>Resolves to</dt>
                  <dd>{status.resolvedPath}</dd>
                </>
              )}
              <dt>Chosen by</dt>
              <dd>{status.isOverride ? 'You (custom executable)' : 'Automatic detection'}</dd>
            </dl>
          )}
          {failure && <ErrorNotice error={failure} />}
          {message && <p role="status">{message}</p>}
          <div className="settings-actions">
            <Button disabled={busy} onClick={() => void run(exiftoolStatus)}>
              Retry
            </Button>
            <Button
              disabled={busy}
              onClick={() =>
                void run(
                  chooseExiftoolOverride,
                  'That file is not a usable ExifTool, so the previous setting was kept.',
                )
              }
            >
              Choose executable…
            </Button>
            {status?.isOverride && (
              <Button disabled={busy} onClick={() => void run(resetExiftoolOverride)}>
                Use automatic detection
              </Button>
            )}
          </div>
        </section>

        <section aria-labelledby="settings-about">
          <h3 id="settings-about">About</h3>
          <p>
            ExifBee {appVersion ?? ''} · MIT License. Third-party licenses are listed in
            THIRD_PARTY_NOTICES.
          </p>
          <p>
            Powered by ExifTool by Phil Harvey (exiftool.org)
            {status?.version ? `, version ${status.version} in use` : ''}. ExifBee is an independent
            project, not affiliated with or endorsed by ExifTool&apos;s author.
          </p>
        </section>
      </div>
    </Dialog>
  );
}
