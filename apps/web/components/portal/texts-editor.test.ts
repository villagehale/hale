import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { namesKeyword } from '~/lib/channel/no-stop-keyword';
import { DEFAULT_LOOP_PREFS } from '~/lib/loop/prefs';
import { TextsEditor } from './texts-editor';

vi.mock('~/lib/settings/loop-prefs-actions', () => ({ setLoopPrefAction: vi.fn() }));
vi.mock('~/lib/settings/loop-prefs', () => ({
  loadLoopNotificationPrefs: async () => ({ status: 'unavailable' }),
}));
vi.mock('~/lib/dashboard/queries', () => ({
  loadFamilyBasics: async () => ({ children: [] }),
}));

const TODAY = 'To pause all texts, reply STOP to Hale. Reply START to turn them back on.';
const KEYWORD_FREE =
  'To stop Hale’s texts to you, tell Hale in your own words. When you want them back, tell Hale that too.';

function rendered(noStopKeyword: boolean) {
  return renderToStaticMarkup(
    createElement(TextsEditor, { prefs: DEFAULT_LOOP_PREFS, childFirstName: null, noStopKeyword }),
  ).replaceAll('&#x27;', "'");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('TextsEditor way-out line (VIL-744)', () => {
  it("keeps today's line with the flag off", () => {
    const html = rendered(false);
    expect(html).toContain(TODAY);
    expect(html).not.toContain(KEYWORD_FREE);
  });

  it('names no keyword with the flag on', () => {
    const html = rendered(true);
    expect(html).toContain(KEYWORD_FREE);
    expect(html).not.toContain(TODAY);
    expect(html).not.toMatch(/STOP|START/);
    expect(namesKeyword(KEYWORD_FREE)).toBeNull();
  });
});

describe('the app pages hand the flag to their client components', () => {
  it.each([
    [
      'the settings page',
      async () => (await import('~/app/(authed)/settings/texts/page')).default(),
    ],
    [
      'the demo page',
      async () => (await import('~/app/demo/portal/settings/texts/page')).default(),
    ],
  ])('%s follows the flag', async (_name, page) => {
    vi.stubEnv('NO_STOP_KEYWORD_COPY_ENABLED', 'false');
    const dark = renderToStaticMarkup(await page());
    expect(dark).toContain('reply STOP to Hale');
    vi.stubEnv('NO_STOP_KEYWORD_COPY_ENABLED', 'true');
    const lit = renderToStaticMarkup(await page());
    expect(lit).not.toMatch(/STOP|START/);
    expect(lit).toContain('tell Hale in your own words');
  });
});
