import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// The selector transitively imports a 'use server' action (→ ~/auth → next-auth)
// and next/navigation's useRouter; neither resolves under a static-markup render,
// so both are mocked (mirrors find-activities-button.test.ts).
vi.mock('~/lib/village/search-action', () => ({ searchActivitiesForSeasonAction: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { VillageSeasonSelector } from './village-season-selector';

/**
 * The season selector renders one chip per season plus a "your feed" chip. The
 * active-view highlight (spruce fill) is the only thing a static render can pin,
 * so we assert which chip carries it: standing feed by default, the searched
 * season when `?season=` is active. The action result → UI decision is covered
 * as a pure unit in season-selector-ui.test.ts.
 */
describe('VillageSeasonSelector — chips + active-view highlight', () => {
  it('offers a chip for each season and the standing feed', () => {
    const html = renderToStaticMarkup(createElement(VillageSeasonSelector));
    for (const season of ['spring', 'summer', 'fall', 'winter']) {
      expect(html).toContain(`>${season}</button>`);
    }
    expect(html).toContain('your feed');
  });

  it('highlights the standing feed when no season is active', () => {
    const html = renderToStaticMarkup(createElement(VillageSeasonSelector));
    // The "your feed" link carries the active (spruce) fill; the season chips do not.
    expect(html).toMatch(/your feed<\/a>/);
    expect(html).toContain('bg-spruce text-on-spruce');
    // Exactly one chip is active — the standing feed. No season button is filled.
    expect(html).not.toMatch(/bg-spruce text-on-spruce[^>]*>spring/);
  });

  it('highlights the searched season chip when a season is active', () => {
    const html = renderToStaticMarkup(
      createElement(VillageSeasonSelector, { active: 'fall' as const }),
    );
    expect(html).toMatch(/class="pill pill-action bg-spruce text-on-spruce"[^>]*>fall<\/button>/);
    // The standing-feed chip is no longer the active one.
    expect(html).toMatch(/bg-transparent text-slate-green"[^>]*>your feed<\/a>/);
  });
});
