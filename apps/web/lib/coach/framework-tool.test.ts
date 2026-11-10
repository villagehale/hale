import { afterEach, describe, expect, it, vi } from 'vitest';
import { frameworkGuidanceTool } from './framework-tool';

/**
 * D6 (2026-11-04): the companion's routine health table is Canada's, so a US family's
 * tool answers carry no schedule and name why, and a Canadian family's are unchanged.
 * The Canadian description is pinned byte for byte: it rides every coach-channel
 * recording's cache key, so any change to it re-keys the whole suite.
 */

const CANADIAN_DESCRIPTION =
  "The Child Development & Wellbeing Companion for a stage: curated 'what matters now' guidance, milestone windows, and the Canadian health/immunization cadence. ALWAYS pass ageMonths when you know the child's age (get_child_profile returns it) — the 'child' stage spans four years old to twelve, and without an age this answers for the middle of it. Every item is general guidance — surface the confirm-with-provider note for anything health-related (rule #1).";

// A 3-month-old is due the 4-month set on the Canadian schedule.
const INPUT = { stage: 'newborn', ageMonths: 3 } as const;

type Answer = Record<string, unknown> & { nextHealth?: Array<{ what: string; kind: string }> };

async function answer(country: 'CA' | 'US' | null): Promise<Answer> {
  return (await frameworkGuidanceTool(country).handler(INPUT, {} as never)) as Answer;
}

describe('get_framework_guidance by family country', () => {
  afterEach(() => vi.useRealTimers());

  it('a Canadian family gets the Canadian cadence and the description as before (positive control)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T12:00:00Z'));
    const result = await answer('CA');
    expect(result.nextHealth?.map((h) => h.what)).toContain('4-month immunizations');
    expect(Object.keys(result)).toEqual([
      'stage',
      'ageMonths',
      'whatsNow',
      'whatsNext',
      'milestones',
      'nextHealth',
      'confirmWithProvider',
    ]);
    expect(frameworkGuidanceTool('CA').description).toBe(CANADIAN_DESCRIPTION);
  });

  it('a US family gets no Canadian cadence, and the named outcome instead', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T12:00:00Z'));
    const result = await answer('US');
    expect(result).not.toHaveProperty('nextHealth');
    expect(result.healthSchedule).toBe('no_verified_us_schedule');
    expect(JSON.stringify(result)).not.toMatch(/immuni[sz]ation|well-baby/i);
    // The guidance that is not country-keyed still answers.
    expect((result.milestones as unknown[]).length).toBeGreaterThan(0);
    expect(frameworkGuidanceTool('US').description).not.toMatch(/canad|immuni[sz]ation cadence/i);
  });

  it('a family Hale cannot place is not given the Canadian cadence by default', async () => {
    const result = await answer(null);
    expect(result).not.toHaveProperty('nextHealth');
    expect(result.healthSchedule).toBe('country_unknown');
    expect(frameworkGuidanceTool(null).description).not.toMatch(/canad/i);
  });
});
