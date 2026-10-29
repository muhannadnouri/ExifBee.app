// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ERROR_KINDS, ERROR_TEXT } from '../lib/errors';
import { ErrorNotice } from './ErrorNotice';

afterEach(cleanup);

// @req NFR-004, UX-005
describe('ErrorNotice', () => {
  it.each(ERROR_KINDS)('shows a %s error as an alert with title, detail and hint', (kind) => {
    render(<ErrorNotice error={{ kind, message: `detail for ${kind}` }} />);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain(ERROR_TEXT[kind].title);
    expect(alert.textContent).toContain(`detail for ${kind}`);
    expect(alert.textContent).toContain(ERROR_TEXT[kind].hint);
  });
});
