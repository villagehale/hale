// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installMetaPixel } from './meta-pixel-client.js';

const OLD_ID = '1460101092968766';
const NEW_ID = '2041301346827688';

interface PixelWindow extends Window {
  fbq?: { queue?: unknown[][] };
  _fbq?: unknown;
  __haleMetaPixel?: boolean;
}

function queue(): unknown[][] {
  return ((window as PixelWindow).fbq?.queue ?? []) as unknown[][];
}

beforeEach(() => {
  const happy = (
    window as Window & {
      happyDOM?: { settings: { handleDisabledFileLoadingAsSuccess: boolean } };
    }
  ).happyDOM;
  if (happy) happy.settings.handleDisabledFileLoadingAsSuccess = true;
});

afterEach(() => {
  for (const node of document.head.querySelectorAll('script')) node.remove();
  const w = window as PixelWindow;
  w.fbq = undefined;
  w._fbq = undefined;
  w.__haleMetaPixel = undefined;
});

describe('installMetaPixel', () => {
  it('inits one id and tracks PageView once', () => {
    installMetaPixel(OLD_ID);
    expect(queue()).toEqual([
      ['init', OLD_ID],
      ['track', 'PageView'],
    ]);
  });

  it('inits each id, then tracks PageView once', () => {
    installMetaPixel(`${OLD_ID}, ${NEW_ID}`);
    expect(queue().filter(([method]) => method === 'init')).toEqual([
      ['init', OLD_ID],
      ['init', NEW_ID],
    ]);
    expect(
      queue().filter(([method, name]) => method === 'track' && name === 'PageView'),
    ).toHaveLength(1);
    expect(queue().some(([method]) => method === 'trackSingle')).toBe(false);
  });
});
