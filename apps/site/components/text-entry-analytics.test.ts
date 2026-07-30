import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildEvent } from '~/lib/analytics/events.js';

/**
 * The QR card's venue code has to survive the whole way to PostHog, or the
 * scoreboard cannot tell which physical spot starts conversations (VIL-240).
 *
 * The site's test suite has no DOM (every test renders to static markup), so
 * `useEffect` is substituted with a synchronous call for this file only — that
 * is the sole reason the effect body would not otherwise run. The seam under
 * test is real: the mocked `useAnalytics` is the same module the component
 * imports, and the assertions are on what the component actually passes it.
 */

const capture = vi.fn();

vi.mock('~/lib/analytics/posthog-provider', () => ({ useAnalytics: () => capture }));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual, useEffect: (effect: () => void) => effect() };
});

const { TextEntryAnalytics } = await import('./text-entry-analytics.js');

function view(source: string | null): void {
  renderToStaticMarkup(createElement(TextEntryAnalytics, { source }));
}

beforeEach(() => {
  capture.mockClear();
});

describe('TextEntryAnalytics', () => {
  it('captures the view attributed to the venue code from ?s=', () => {
    view('earlyon-richmondhill');
    expect(capture).toHaveBeenCalledWith('text_entry_viewed', { source: 'earlyon-richmondhill' });
  });

  it('captures a plain view when nobody handed out a card', () => {
    view(null);
    expect(capture).toHaveBeenCalledWith('text_entry_viewed', {});
  });

  it('renders nothing — it is an event, not UI', () => {
    expect(renderToStaticMarkup(createElement(TextEntryAnalytics, { source: null }))).toBe('');
  });
});

describe('text_entry_viewed (privacy gate)', () => {
  it('keeps the venue code, which is a place and not a person', () => {
    expect(buildEvent('text_entry_viewed', { source: 'swim-loyalfitness' })).toEqual({
      event: 'text_entry_viewed',
      properties: { source: 'swim-loyalfitness' },
    });
  });

  it('still drops anything identifying that ever reached it', () => {
    expect(
      buildEvent('text_entry_viewed', { source: 'swim-loyalfitness', email: 'a@b.com' }).properties,
    ).toEqual({ source: 'swim-loyalfitness' });
  });
});
