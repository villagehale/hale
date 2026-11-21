import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sharedOpsPager } from '~/lib/monitoring/shared-ops-pager';
import { groupPlanCalendarLineInput } from './calendar';
import { groupPlanWhichLineInput } from './facts';
import { composeGroupPlanRsvpLine } from './voice';
import { fakeGroupPlanRsvpComposer } from './voice-fake';

const written = groupPlanCalendarLineInput({
  kind: 'calendar_written',
  language: 'en',
  parentWords: 'yes please',
  facts: {
    title: 'Saturday picnic',
    startsAt: 'Sun, Nov 1 at 11:00 AM',
    location: 'the park',
    displayName: 'Priya',
    householdLabel: null,
  },
});

/** `first` answers the full prompt, `retry` the short one. */
async function compose(first: string, retry: string) {
  const composer = fakeGroupPlanRsvpComposer();
  const lines = [first, retry];
  const spoken = await composeGroupPlanRsvpLine(written, {
    async compose(input, options) {
      await composer.compose(input, options);
      return { line: lines[composer.calls.length - 1] ?? '' };
    },
  });
  return { spoken, prompts: composer.calls.map((call) => call.prompt) };
}

describe('a private calendar line', () => {
  it('keeps a line that only states the plan and its time', async () => {
    const { spoken, prompts } = await compose(
      'Done, the Saturday picnic is on your calendar for Sun, Nov 1 at 11:00 AM.',
      'unused',
    );
    expect(spoken).toEqual({
      status: 'composed',
      source: 'composed',
      line: 'Done, the Saturday picnic is on your calendar for Sun, Nov 1 at 11:00 AM.',
    });
    expect(prompts).toEqual(['full']);
  });

  it.each([
    ['a phone number', 'Added. Call 555-0142 with questions.'],
    ['a phone number with a country code', 'Added. Text +1 202 555 0142 with questions.'],
    ['an email address', 'Added. Write to host@picnic for details.'],
    ['a link', 'Added. Details at picnic.app/sat.'],
  ])('refuses %s and keeps the clean retry', async (_label, carrying) => {
    const clean = 'Added the Saturday picnic to your calendar.';
    const { spoken, prompts } = await compose(carrying, clean);
    expect(spoken).toEqual({ status: 'composed', source: 'retry', line: clean });
    expect(prompts).toEqual(['full', 'short']);
  });

  it('sends nothing when both drafts carry a phone number', async () => {
    const { spoken } = await compose('Call 555-0142.', 'Or text 555-0199.');
    expect(spoken).toEqual({ status: 'skipped', reason: 'model_failed' });
  });
});

describe('a line the model could not write pages #ops (scenes on)', () => {
  const moved = groupPlanCalendarLineInput({
    kind: 'calendar_moved',
    language: 'en',
    parentWords: null,
    facts: {
      title: 'Saturday picnic',
      startsAt: 'Sun, Nov 1 at 1:00 PM',
      location: null,
      displayName: 'Priya',
      householdLabel: null,
    },
  });
  const whichPlan = groupPlanWhichLineInput({
    language: 'en',
    choices: [
      { title: 'zoo', startsAt: null },
      { title: 'museum', startsAt: null },
    ],
  });

  beforeEach(() => {
    vi.stubEnv('LINQ_GROUP_SCENES_ENABLED', 'true');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('names the kind and the reason, and still sends nothing', async () => {
    const page = vi.spyOn(sharedOpsPager, 'page').mockResolvedValue('paged');
    const spoken = await composeGroupPlanRsvpLine(moved, fakeGroupPlanRsvpComposer({ fail: true }));
    expect(spoken).toEqual({ status: 'skipped', reason: 'model_failed' });
    expect(page.mock.calls).toEqual([
      [
        {
          site: 'group_plan_line_unwritten',
          facts: { kind: 'calendar_moved', reason: 'model_failed' },
        },
      ],
    ]);
  });

  it('pages the group which-plan line by its own kind', async () => {
    const page = vi.spyOn(sharedOpsPager, 'page').mockResolvedValue('paged');
    await composeGroupPlanRsvpLine(whichPlan, fakeGroupPlanRsvpComposer({ fail: true }));
    expect(page.mock.calls[0]?.[0]).toEqual({
      site: 'group_plan_line_unwritten',
      facts: { kind: 'which_plan', reason: 'model_failed' },
    });
  });

  it('pages when no voice is configured at all', async () => {
    const page = vi.spyOn(sharedOpsPager, 'page').mockResolvedValue('paged');
    const spoken = await composeGroupPlanRsvpLine(moved, undefined);
    expect(spoken).toEqual({ status: 'skipped', reason: 'voice_unavailable' });
    expect(page.mock.calls[0]?.[0]).toEqual({
      site: 'group_plan_line_unwritten',
      facts: { kind: 'calendar_moved', reason: 'voice_unavailable' },
    });
  });

  it('positive control: a line the model wrote pages nothing', async () => {
    const page = vi.spyOn(sharedOpsPager, 'page').mockResolvedValue('paged');
    const spoken = await composeGroupPlanRsvpLine(moved, fakeGroupPlanRsvpComposer());
    expect(spoken.status).toBe('composed');
    expect(page).not.toHaveBeenCalled();
  });

  it('with the scenes off the path pages nothing, as it does today', async () => {
    vi.stubEnv('LINQ_GROUP_SCENES_ENABLED', '');
    const page = vi.spyOn(sharedOpsPager, 'page').mockResolvedValue('paged');
    const spoken = await composeGroupPlanRsvpLine(moved, fakeGroupPlanRsvpComposer({ fail: true }));
    expect(spoken).toEqual({ status: 'skipped', reason: 'model_failed' });
    expect(page).not.toHaveBeenCalled();
  });
});
