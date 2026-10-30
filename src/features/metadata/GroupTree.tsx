import type { GroupNode, GroupScope } from './tagFilter';
import './GroupTree.css';

type Props = {
  tree: GroupNode[];
  total: number;
  scope: GroupScope;
  onScope: (scope: GroupScope) => void;
};

const same = (a: GroupScope, b: GroupScope) => a?.family === b?.family && a?.group === b?.group;

/**
 * Group families (EXIF, XMP, QuickTime…) and their specific groups (IFD0, XMP-dc…) with tag
 * counts. Each entry is a toggle button, so the tree is plain Tab navigation, not a widget to
 * learn; the pressed one scopes the table.
 */
export function GroupTree({ tree, total, scope, onScope }: Props) {
  const entry = (label: string, count: number, target: GroupScope, nested = false) => (
    <button
      type="button"
      className={nested ? 'group-tree-entry group-tree-nested' : 'group-tree-entry'}
      aria-pressed={same(scope, target)}
      onClick={() => onScope(target)}
    >
      <span>{label}</span>
      <span className="group-tree-count">{count.toLocaleString('en-US')}</span>
    </button>
  );
  return (
    <nav className="group-tree" aria-label="Tag groups">
      <ul>
        <li>{entry('All groups', total, null)}</li>
        {tree.map((node) => (
          <li key={node.family}>
            {entry(node.family, node.count, { family: node.family })}
            {node.groups.length > 1 || node.groups[0]?.group !== node.family ? (
              <ul>
                {node.groups.map(({ group, count }) => (
                  <li key={group}>{entry(group, count, { family: node.family, group }, true)}</li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>
    </nav>
  );
}
