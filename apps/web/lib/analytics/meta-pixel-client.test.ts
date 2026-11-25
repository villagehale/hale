// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installMetaPixel } from './meta-pixel-client.js';

const OLD_ID = '1111111111111111';
const NEW_ID = '2222222222222222';

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
  it('turns off automatic events, inits one id and tracks PageView once', () => {
    installMetaPixel(OLD_ID);
    expect(queue()).toEqual([
      ['set', 'autoConfig', false, OLD_ID],
      ['init', OLD_ID],
      ['track', 'PageView'],
    ]);
  });

  it('turns off automatic events for each id before its init, then tracks PageView once', () => {
    installMetaPixel(`${OLD_ID}, ${NEW_ID}`);
    expect(queue().filter(([method]) => method !== 'track')).toEqual([
      ['set', 'autoConfig', false, OLD_ID],
      ['init', OLD_ID],
      ['set', 'autoConfig', false, NEW_ID],
      ['init', NEW_ID],
    ]);
    expect(
      queue().filter(([method, name]) => method === 'track' && name === 'PageView'),
    ).toHaveLength(1);
    expect(queue().some(([method]) => method === 'trackSingle')).toBe(false);
  });
});
