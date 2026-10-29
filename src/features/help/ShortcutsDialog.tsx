import { SHORTCUTS } from '../../app/shortcuts';
import { Dialog } from '../../components/Dialog';
import './ShortcutsDialog.css';

export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog id="shortcuts" title="Keyboard shortcuts" open={open} onClose={onClose}>
      <table className="shortcuts">
        <thead>
          <tr>
            <th scope="col">Keys</th>
            <th scope="col">Action</th>
          </tr>
        </thead>
        <tbody>
          {SHORTCUTS.map(({ keys, action }) => (
            <tr key={keys}>
              <th scope="row">
                <kbd>{keys}</kbd>
              </th>
              <td>{action}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Dialog>
  );
}
