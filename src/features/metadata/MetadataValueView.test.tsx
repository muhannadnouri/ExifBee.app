// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { MetadataValue } from '../../lib/ipc';
import { MetadataValueView } from './MetadataValueView';

afterEach(cleanup);
const shown = (value: MetadataValue) => render(<MetadataValueView value={value} />).container;

// @req FR-005, FR-023, SEC-003
describe('MetadataValueView', () => {
  it('shows text exactly, including numbers ExifTool printed with zeros or exponents', () => {
    expect(shown({ kind: 'text', text: '13.50' }).textContent).toBe('13.50');
    expect(shown({ kind: 'text', text: '007' }).textContent).toBe('007');
    expect(shown({ kind: 'text', text: '' }).textContent).toBe('(empty)');
  });

  it('joins plain lists and nests mixed ones', () => {
    const list: MetadataValue = {
      kind: 'list',
      items: [
        { kind: 'text', text: 'bee' },
        { kind: 'text', text: 'fixture' },
      ],
    };
    expect(shown(list).textContent).toBe('bee, fixture');
    const mixed = shown({
      kind: 'list',
      items: [
        { kind: 'text', text: 'a' },
        { kind: 'structure', fields: [] },
      ],
    });
    expect(mixed.querySelectorAll('li')).toHaveLength(2);
  });

  it('shows structures as named fields', () => {
    const view = shown({
      kind: 'structure',
      fields: [{ name: 'CiAdrCity', value: { kind: 'text', text: 'Fixture City' } }],
    });
    expect(view.querySelector('dt')?.textContent).toBe('CiAdrCity');
    expect(view.querySelector('dd')?.textContent).toBe('Fixture City');
  });

  it('describes binary data by size instead of printing bytes', () => {
    expect(shown({ kind: 'binary', byteLength: 768 }).textContent).toBe('Binary data · 768 bytes');
    expect(shown({ kind: 'binary', byteLength: null }).textContent).toBe(
      'Binary data · unknown size',
    );
  });

  it('never turns markup in values or field names into elements', () => {
    const view = shown({
      kind: 'structure',
      fields: [{ name: '<b>x</b>', value: { kind: 'text', text: '<img src=x onerror=alert(1)>' } }],
    });
    expect(view.querySelector('img, b')).toBeNull();
    expect(view.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});
