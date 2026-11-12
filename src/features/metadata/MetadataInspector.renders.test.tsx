// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tagsOf } from '../../../tests/support/tags';
import type { FileMetadata } from '../../lib/ipc';
import { MetadataInspector } from './MetadataInspector';

// Counts how often the table body is drawn, standing in for thousands of tag rows.
const drawn = vi.hoisted(() => ({ count: 0 }));
vi.mock('./TagRows', () => ({
  TagRows: () => {
    drawn.count++;
    return <tbody />;
  },
}));

afterEach(cleanup);

const noEdit = () => undefined;
const none = new Set<string>();

const file = (sourceFile: string): FileMetadata => ({
  sourceFile,
  error: null,
  unsupported: false,
  formatWritable: true,
  warnings: [],
  tags: tagsOf({ 'IFD0:Make': 'Canon' }),
});

// @req NFR-002, NFR-003
describe('inspector re-render guard', () => {
  it('does not redraw its tags when the app re-renders for something else', () => {
    const shown = file('/a.jpg');
    drawn.count = 0;
    const { rerender } = render(
      <MetadataInspector file={shown} failure={null} reading onEdit={noEdit} staged={none} />,
    );
    expect(drawn.count).toBe(1);
    // e.g. scan or read progress, several times a second: same props, no redraw.
    for (let i = 0; i < 20; i++)
      rerender(
        <MetadataInspector file={shown} failure={null} reading onEdit={noEdit} staged={none} />,
      );
    expect(drawn.count).toBe(1);

    rerender(
      <MetadataInspector
        file={file('/b.jpg')}
        failure={null}
        reading
        onEdit={noEdit}
        staged={none}
      />,
    );
    expect(drawn.count).toBe(2);
  });
});
