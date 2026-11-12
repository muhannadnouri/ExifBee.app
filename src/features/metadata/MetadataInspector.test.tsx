// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { tagsOf } from '../../../tests/support/tags';
import type { FileMetadata } from '../../lib/ipc';
import { MetadataInspector } from './MetadataInspector';

afterEach(cleanup);

const noEdit = () => undefined;
const none = new Set<string>();

const photo: FileMetadata = {
  sourceFile: '/files/photo.jpg',
  error: null,
  unsupported: false,
  formatWritable: true,
  warnings: [],
  tags: tagsOf(
    {
      'System:FileName': 'photo.jpg',
      'File:FileType': 'JPEG',
      'IFD0:Make': 'Canon',
      'IFD0:Model': 'EOS 10',
      'XMP-tiff:Copy1:Make': 'Canon (XMP)',
      'XMP-dc:Title': 'Bee on lavender',
      'Composite:ImageSize': '10x2',
    },
    {
      'System:FileName': ['File', 'writable'],
      'File:FileType': ['File', 'readOnly'],
      'IFD0:Make': ['EXIF', 'writable'],
      'IFD0:Model': ['EXIF', 'writable'],
      'XMP-tiff:Copy1:Make': ['XMP', 'writable'],
      'XMP-dc:Title': ['XMP', 'writable'],
      'Composite:ImageSize': ['Composite', 'readOnly'],
    },
  ),
};
/** Row headers' accessible names: the full Group:Tag key. */
const rowHeaders = () =>
  screen.getAllByRole('rowheader').map((header) => header.getAttribute('aria-label'));

// @req FR-006, UX-006, TST-003
describe('metadata inspector', () => {
  it('tells same-name tags apart by group and copy, and shows each one’s writability', () => {
    render(
      <MetadataInspector
        file={photo}
        failure={null}
        reading={false}
        onEdit={noEdit}
        staged={none}
      />,
    );
    // Row headers are named by the full key for screen readers; the Group column shows it.
    expect(rowHeaders()).toContain('IFD0:Make');
    expect(rowHeaders()).toContain('XMP-tiff:Copy1:Make');
    const xmpMake = screen.getByRole('row', { name: /XMP-tiff:Copy1:Make/ });
    expect(within(xmpMake).getAllByRole('cell')[0]?.textContent).toBe('XMP-tiff · copy 1');
    expect(within(xmpMake).getByText('Writable')).toBeTruthy();
    const size = screen.getByRole('row', { name: /Composite:ImageSize/ });
    expect(within(size).getByText('Read-only').getAttribute('title')).toBe(
      'This tag or file format is not writable through the selected ExifTool version.',
    );
    // No photo-centric wording in the inspector's own labels.
    const labels = screen.getAllByRole('columnheader').map((header) => header.textContent);
    expect(labels).toEqual(['Group', 'Tag', 'Value', 'Write', 'Actions']);
  });

  it('narrows by group tree, search and writability, and clears back to everything', async () => {
    const user = userEvent.setup();
    render(
      <MetadataInspector
        file={photo}
        failure={null}
        reading={false}
        onEdit={noEdit}
        staged={none}
      />,
    );
    const tree = within(screen.getByRole('navigation', { name: 'Tag groups' }));
    expect(tree.getAllByRole('button').map((button) => button.textContent)).toEqual([
      'All groups7',
      'File2',
      'System1',
      'File1',
      'EXIF2',
      'IFD02',
      'XMP2',
      'XMP-tiff1',
      'XMP-dc1',
      'Composite1',
    ]);

    await user.click(tree.getByRole('button', { name: /^XMP2/ }));
    expect(rowHeaders()).toEqual(['XMP-tiff:Copy1:Make', 'XMP-dc:Title']);
    expect(screen.getByText('2 of 7 tags')).toBeTruthy();

    await user.click(tree.getByRole('button', { name: /^All groups/ }));
    await user.type(screen.getByRole('searchbox', { name: 'Find tags' }), 'canon');
    expect(rowHeaders()).toEqual(['IFD0:Make', 'XMP-tiff:Copy1:Make']);

    await user.selectOptions(screen.getByRole('combobox', { name: 'Show' }), 'readOnly');
    expect(screen.getByText(/No tags match these filters/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(rowHeaders()).toHaveLength(7);
    expect((screen.getByRole('searchbox', { name: 'Find tags' }) as HTMLInputElement).value).toBe(
      '',
    );
  });

  it('sorts by a column ascending, descending, then back to ExifTool order', async () => {
    const user = userEvent.setup();
    render(
      <MetadataInspector
        file={photo}
        failure={null}
        reading={false}
        onEdit={noEdit}
        staged={none}
      />,
    );
    const original = rowHeaders();
    const tagHeader = screen.getByRole('columnheader', { name: /Tag/ });
    await user.click(within(tagHeader).getByRole('button'));
    expect(tagHeader.getAttribute('aria-sort')).toBe('ascending');
    expect(rowHeaders().slice(0, 3)).toEqual([
      'System:FileName',
      'File:FileType',
      'Composite:ImageSize',
    ]);
    await user.click(within(tagHeader).getByRole('button'));
    expect(tagHeader.getAttribute('aria-sort')).toBe('descending');
    expect(rowHeaders()[0]).toBe('XMP-dc:Title');
    await user.click(within(tagHeader).getByRole('button'));
    expect(tagHeader.getAttribute('aria-sort')).toBeNull();
    expect(rowHeaders()).toEqual(original);
  });

  it('copies one value or all visible tags, and says so', async () => {
    const user = userEvent.setup();
    render(
      <MetadataInspector
        file={photo}
        failure={null}
        reading={false}
        onEdit={noEdit}
        staged={none}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Copy value of XMP-dc:Title' }));
    expect(await navigator.clipboard.readText()).toBe('Bee on lavender');
    expect(screen.getByRole('status').textContent).toBe('Copied the value of XMP-dc:Title.');

    await user.type(screen.getByRole('searchbox', { name: 'Find tags' }), 'make');
    await user.click(screen.getByRole('button', { name: 'Copy visible' }));
    expect(await navigator.clipboard.readText()).toBe(
      'IFD0:Make\tCanon\nXMP-tiff:Copy1:Make\tCanon (XMP)',
    );
    expect(screen.getByRole('status').textContent).toBe('Copied 2 tags.');
  });

  it('explains read-only and unconfirmed formats, and keeps filters across files', async () => {
    const user = userEvent.setup();
    const archive: FileMetadata = {
      ...photo,
      sourceFile: '/files/archive.zip',
      formatWritable: false,
      tags: tagsOf(
        { 'System:FileName': 'archive.zip', 'ZIP:ZipFileName': 'hello.txt' },
        { 'System:FileName': ['File', 'writable'], 'ZIP:ZipFileName': ['ZIP', 'readOnly'] },
      ),
    };
    const { rerender } = render(
      <MetadataInspector
        file={photo}
        failure={null}
        reading={false}
        onEdit={noEdit}
        staged={none}
      />,
    );
    await user.click(screen.getByRole('button', { name: /^XMP2/ }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Show' }), 'writable');

    rerender(
      <MetadataInspector
        file={archive}
        failure={null}
        reading={false}
        onEdit={noEdit}
        staged={none}
      />,
    );
    expect(screen.getByText(/This file format is not writable/)).toBeTruthy();
    // The XMP group does not exist here, so the tree falls back to all groups; Show stays.
    expect(screen.getByRole('button', { name: /^All groups/ }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(rowHeaders()).toEqual(['System:FileName']);

    rerender(
      <MetadataInspector
        file={{ ...archive, formatWritable: null }}
        failure={null}
        reading={false}
        onEdit={noEdit}
        staged={none}
      />,
    );
    expect(screen.getByText(/could not be confirmed/)).toBeTruthy();
  });
});
