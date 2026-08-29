import { Phone } from 'lucide-react';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SettingsCard, SettingsRow, SettingsSection } from './settings-card';
import { SettingsRowReveal } from './settings-row-reveal';

/**
 * The flat Settings grammar. Pins the contract the page composes against: a
 * section renders a real anchor id (the deep-link resolver scrolls to it), a row's
 * PII value line carries data-hale-pii (rule #1 — replay masking), and the reveal
 * row is a labelled, wired disclosure (aria-expanded/controls), not a bare div
 * toggle. Static render — the reveal's initial state is closed.
 */

// The props-helper indirection upgrade-prompt.test.ts uses for components whose
// children are required props.
const renderSection = (props: Parameters<typeof SettingsSection>[0]) =>
  renderToStaticMarkup(h(SettingsSection, props));
const renderReveal = (props: Parameters<typeof SettingsRowReveal>[0]) =>
  renderToStaticMarkup(h(SettingsRowReveal, props));

describe('SettingsSection', () => {
  it('renders the anchor id, the muted header, and the explainer', () => {
    const html = renderSection({
      id: 'trust',
      label: 'Trust',
      explainer: 'What Hale holds.',
      children: h('p', null, 'body'),
    });
    expect(html).toContain('id="trust"');
    expect(html).toContain('aria-label="Trust"');
    expect(html).toContain('What Hale holds.');
    expect(html).toContain('body');
  });
});

describe('SettingsRow', () => {
  it('marks a PII value line for replay masking, and only when asked', () => {
    const masked = renderToStaticMarkup(
      h(SettingsRow, { icon: Phone, label: 'Phone', value: '+1 ••• ••• 1234', pii: true }),
    );
    expect(masked).toContain('data-hale-pii');
    expect(masked).toContain('+1 ••• ••• 1234');

    const plain = renderToStaticMarkup(
      h(SettingsRow, { icon: Phone, label: 'Appearance', value: 'Light' }),
    );
    expect(plain).not.toContain('data-hale-pii');
  });

  it('renders no value line at all when there is none (never an empty grey line)', () => {
    const html = renderToStaticMarkup(h(SettingsRow, { icon: Phone, label: 'Appearance' }));
    expect(html).not.toContain('settings-flat-value');
  });
});

describe('SettingsRowReveal', () => {
  const html = renderReveal({
    icon: Phone,
    label: 'Phone',
    value: 'No number linked yet',
    actionLabel: 'Link',
    children: h('p', null, 'the enrolment form'),
  });

  it('starts closed: the action button is collapsed and the machinery is not mounted', () => {
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('>Link<');
    expect(html).not.toContain('the enrolment form');
  });

  it('wraps everything in one card child so the divider grammar holds', () => {
    const card = renderToStaticMarkup(
      h(SettingsCard, null, h(SettingsRow, { icon: Phone, label: 'A' })),
    );
    expect(card).toContain('settings-card');
  });
});
