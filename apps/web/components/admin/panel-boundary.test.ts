import { type ComponentProps, createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TWILIO_ERROR_LOGS_URL } from '~/lib/admin/links';
import { Panel } from './panel';
import { PanelBoundary } from './panel-boundary';

/**
 * The panel-state law: a dead loader loses its data, never its name and never
 * its console link. renderToStaticMarkup does not run error boundaries (React
 * catches on the client only), so the boundary is driven through the same two
 * steps React uses — the body really throws, and that thrown error becomes
 * state through the real getDerivedStateFromError before the boundary renders.
 */
const EYEBROW = 'Errors — Twilio + sends + agent runs';
const LINKS = [{ label: 'Open in Twilio', href: TWILIO_ERROR_LOGS_URL }];

function DeadLoader(): never {
  throw new Error('twilio unreachable');
}

// The props-helper indirection settings-card.test.ts uses for components whose
// children are required props.
const renderPanel = (props: ComponentProps<typeof Panel>) =>
  renderToStaticMarkup(createElement(Panel, props));
const boundary = (props: ComponentProps<typeof PanelBoundary>) =>
  createElement(PanelBoundary, props);

function renderFailedPanel(): string {
  const body = createElement(DeadLoader);
  expect(() => renderToStaticMarkup(body)).toThrow('twilio unreachable');

  const failed = new PanelBoundary({ label: EYEBROW, children: body });
  failed.state = PanelBoundary.getDerivedStateFromError();
  expect(failed.state.failed).toBe(true);

  return renderPanel({ eyebrow: EYEBROW, links: LINKS, children: failed.render() as ReactNode });
}

describe('PanelBoundary — a failed loader names itself', () => {
  it('renders the panel’s own name in the failure line rather than a blank body', () => {
    const html = renderFailedPanel();
    expect(html).toContain(`${EYEBROW} didn’t load — check the logs.`);
    expect(html).toContain('adm-state-fail');
    // The body slot carries the failure line — never an empty div.
    expect(html).toMatch(/<div class="adm-panel-body">.+?<\/div>/);
  });

  it('keeps the external console link the panel was mounted with', () => {
    const html = renderFailedPanel();
    expect(html).toContain(`href="${TWILIO_ERROR_LOGS_URL}"`);
    expect(html).toContain('Open in Twilio');
  });

  it('renders the body untouched while the loader is healthy (positive control)', () => {
    const html = renderPanel({
      eyebrow: EYEBROW,
      links: LINKS,
      children: boundary({
        label: EYEBROW,
        children: createElement('p', { className: 'adm-state' }, '3 failures in the last 30 days.'),
      }),
    });
    expect(html).toContain('3 failures in the last 30 days.');
    expect(html).not.toContain('didn’t load');
    expect(html).toContain(`href="${TWILIO_ERROR_LOGS_URL}"`);
  });
});
