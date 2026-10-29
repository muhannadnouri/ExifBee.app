import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App, ReadResult } from './App';

// @req OPS-001
describe('App', () => {
  it('renders the application heading and the open-file action', () => {
    const html = renderToString(<App />);
    expect(html).toContain('<h1>ExifBee</h1>');
    expect(html).toContain('Open file…');
  });
});

// @req SEC-003, NFR-004
describe('ReadResult', () => {
  it('renders hostile metadata as text, never as HTML', () => {
    const html = renderToString(
      <ReadResult
        state={{
          status: 'read',
          file: {
            sourceFile: '/x/<b>name</b>.jpg',
            error: null,
            warnings: [],
            tags: { 'XMP-dc:Title': '<img src=x onerror=alert(1)>', 'XMP-dc:Subject': ['a', 'b'] },
          },
        }}
      />,
    );
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('[&quot;a&quot;,&quot;b&quot;]');
  });

  it('shows structured errors and per-file ExifTool errors as alerts', () => {
    const failed = renderToString(
      <ReadResult
        state={{
          status: 'failed',
          error: { kind: 'DependencyMissing', message: 'ExifTool was not found.' },
        }}
      />,
    );
    expect(failed).toContain('role="alert"');
    expect(failed).toContain('DependencyMissing');

    const perFile = renderToString(
      <ReadResult
        state={{
          status: 'read',
          file: { sourceFile: '/x/empty.bin', error: 'File is empty', warnings: [], tags: {} },
        }}
      />,
    );
    expect(perFile).toMatch(/role="alert">ExifTool error: (<!-- -->)?File is empty/);
  });
});
