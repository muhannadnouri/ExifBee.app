import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App } from './App';

// @req OPS-001
describe('App', () => {
  it('renders the application heading', () => {
    expect(renderToString(<App />)).toContain('<h1>ExifBee</h1>');
  });
});
