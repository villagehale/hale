import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SettingsHub } from './settings-hub';
import { SETTINGS_SECTIONS, type SettingsSectionId } from './settings-sections';

/**
 * Render-level check for the hub shell (§4.7). Rendered to static markup (the
 * client shell owns which section shows; the initial render is Account, effects
 * don't run in SSR — same render-to-HTML approach as the account-menu test). Pins:
 * all six sections appear in the sub-nav; the initial section is the only one shown
 * (the other five carry `hidden`); exactly one nav item is aria-current.
 */
function render(): string {
  const sections = {} as Record<SettingsSectionId, React.ReactNode>;
  for (const { id } of SETTINGS_SECTIONS) {
    sections[id] = createElement('p', null, `body:${id}`);
  }
  // renderToStaticMarkup escapes the '&' in a label ("Family & children") to
  // '&amp;'; decode it back so a label assertion reads the text as a user sees it.
  return renderToStaticMarkup(createElement(SettingsHub, { sections })).replaceAll('&amp;', '&');
}

describe('SettingsHub render', () => {
  const html = render();

  it('renders all six section labels in the sub-nav', () => {
    for (const { label } of SETTINGS_SECTIONS) {
      expect(html).toContain(label);
    }
  });

  it('shows exactly one section (Account) and hides the other five', () => {
    expect((html.match(/hidden=""/g) ?? []).length).toBe(5);
    // Account's section carries no hidden attribute (it is the initial section).
    expect(html).toMatch(/id="account"(?![^>]*hidden)/);
  });

  it('marks exactly one nav item as the current page', () => {
    expect((html.match(/aria-current="page"/g) ?? []).length).toBe(1);
  });
});
