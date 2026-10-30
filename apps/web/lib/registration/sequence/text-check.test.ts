import type { AgentClient } from '@hale/agent';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HeadsUpFacts, MorningFacts } from './copy';
import { composeRegistrationHeadsUp } from './heads-up-compose';
import { composeRegistrationMorning } from './morning-compose';
import { checkRegistrationText } from './text-check';

const forceToolJson = vi.hoisted(() => vi.fn());
vi.mock('~/lib/pipeline/structured', () => ({ forceToolJson }));
vi.mock('~/lib/cron/skill', () => ({
  loadCronSkill: vi.fn(async (name: string) => ({
    meta: { task: name === 'registration-text-check' ? 'screen' : 'speak' },
    instructions: name,
  })),
}));

const CLIENT = {} as AgentClient;
const HEADS_UP: HeadsUpFacts & { language: 'en' } = {
  language: 'en',
  now: { date: 'Tuesday, September 8, 2026', time: '10:00 a.m.' },
  window: 'Richmond Hill Fall 2026 recreation programs',
  who: 'Max',
  opensOn: 'Tuesday, September 15, 2026',
  opensAt: '6:30 a.m.',
  residentsFirst: false,
  ageApproximate: false,
  next: 'plan_promised',
};
const LINK = 'https://townofoakville.example/signin';
const MORNING: MorningFacts & { language: 'en' } = {
  language: 'en',
  now: { date: 'Tuesday, September 15, 2026', time: '10:15 a.m.' },
  window: 'Oakville Fall 2026 programs',
  portal: "Oakville's portal",
  link: LINK,
  situation: 'opens',
  had: '10:30 a.m.',
  setup: 'told_done',
  ageBand: null,
  children: 1,
  pageShows: null,
};

// Draft strings are opaque fixtures: the check's verdict is stubbed, so nothing here
// asserts parent-facing wording.
const DRAFT_A = 'draft a';
const DRAFT_B = 'draft b';
const FAIL = { supported: false, unsupported: ['spot held'] };
const PASS = { supported: true, unsupported: [] };

beforeEach(() => forceToolJson.mockReset());

describe.each([
  [
    'heads_up',
    (check: never) => composeRegistrationHeadsUp(CLIENT, HEADS_UP, 'fam', { check }),
    HEADS_UP,
    '',
  ],
  [
    'morning',
    (check: never) => composeRegistrationMorning(CLIENT, MORNING, 'fam', { check }),
    MORNING,
    ` ${LINK}`,
  ],
] as const)(
  'VIL-488 · %s draft is fact-checked before it can send',
  (kind, compose, facts, suffix) => {
    it('sends nothing when every draft fails the check (false spot held / wrong day)', async () => {
      const check = vi.fn(async () => FAIL);
      forceToolJson.mockResolvedValue({ value: { text: `${DRAFT_A}${suffix}` } });
      await expect(compose(check as never)).resolves.toBeNull();
      expect(check).toHaveBeenCalledTimes(2);
      expect(check).toHaveBeenCalledWith(CLIENT, kind, facts, `${DRAFT_A}${suffix}`, 'fam');
    });

    it('sends a clean draft the check passes', async () => {
      const check = vi.fn(async () => PASS);
      forceToolJson.mockResolvedValue({ value: { text: `${DRAFT_A}${suffix}` } });
      await expect(compose(check as never)).resolves.toBe(`${DRAFT_A}${suffix}`);
    });

    it('retries, and sends the later draft that passes', async () => {
      const check = vi.fn().mockResolvedValueOnce(FAIL).mockResolvedValueOnce(PASS);
      forceToolJson
        .mockResolvedValueOnce({ value: { text: `${DRAFT_A}${suffix}` } })
        .mockResolvedValueOnce({ value: { text: `${DRAFT_B}${suffix}` } });
      await expect(compose(check as never)).resolves.toBe(`${DRAFT_B}${suffix}`);
    });

    it('never checks a draft the structural refusals already dropped', async () => {
      const check = vi.fn(async () => PASS);
      forceToolJson.mockResolvedValue({ value: { text: '  ' } });
      await expect(compose(check as never)).resolves.toBeNull();
      expect(check).not.toHaveBeenCalled();
    });
  },
);

describe('checkRegistrationText', () => {
  it('is not sendable when the check call fails', async () => {
    forceToolJson.mockRejectedValueOnce(new Error('timeout'));
    await expect(
      checkRegistrationText(CLIENT, 'heads_up', HEADS_UP, DRAFT_A, 'fam'),
    ).resolves.toEqual({
      supported: false,
      unsupported: ['check_failed'],
    });
  });

  it('is not sendable when the checker says supported but lists a claim', async () => {
    forceToolJson.mockResolvedValue({ value: { supported: true, unsupported: ['registered'] } });
    const verdict = await checkRegistrationText(CLIENT, 'morning', MORNING, DRAFT_A, 'fam');
    expect(verdict.supported).toBe(false);
  });

  it('passes a clean verdict through', async () => {
    forceToolJson.mockResolvedValue({ value: PASS });
    await expect(
      checkRegistrationText(CLIENT, 'heads_up', HEADS_UP, DRAFT_A, 'fam'),
    ).resolves.toEqual(PASS);
  });
});
