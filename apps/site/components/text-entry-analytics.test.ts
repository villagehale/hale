import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildEvent } from '~/lib/analytics/events.js';

/**
 * The /text view has to reach PostHog attributed, or the scoreboard cannot tell which
 * physical spot starts conversations (VIL-240). Attribution itself is no longer this
 * component's job — the provider stamps first-touch `source_code` on every event — so
 * what is tested here is that the view fires at all, and carries nothing of its own.
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

beforeEach(() => {
  capture.mockClear();
});

describe('TextEntryAnalytics', () => {
  it('captures the view, with no properties of its own to disagree with the provider', () => {
    renderToStaticMarkup(createElement(TextEntryAnalytics));
    expect(capture).toHaveBeenCalledWith('text_entry_viewed');
  });

  it('renders nothing — it is an event, not UI', () => {
    expect(renderToStaticMarkup(createElement(TextEntryAnalytics))).toBe('');
  });
});

describe('text_entry_viewed (privacy gate)', () => {
  it('keeps the venue code, which is a place and not a person', () => {
    expect(buildEvent('text_entry_viewed', { source_code: 'swim-loyalfitness' })).toEqual({
      event: 'text_entry_viewed',
      properties: { source_code: 'swim-loyalfitness' },
    });
  });

  it('still drops anything identifying that ever reached it', () => {
    expect(
      buildEvent('text_entry_viewed', { source_code: 'swim-loyalfitness', email: 'a@b.com' })
        .properties,
    ).toEqual({ source_code: 'swim-loyalfitness' });
  });
});
