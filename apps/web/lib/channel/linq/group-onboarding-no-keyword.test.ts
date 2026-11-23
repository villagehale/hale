import type { Database } from '@hale/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadCronSkill } from '~/lib/cron/skill';
import {
  type GroupOnboardingKind,
  type GroupOnboardingRequest,
  groupOnboardingLineInput,
} from './group-onboarding-line-input';
import { composeOnboardingLine, lineUsable } from './group-onboarding-voice';
import { sharedGroupLineInput } from './shared-group-line-input';
import { sharedLineUsable } from './shared-group-voice';

const composeVoice = vi.hoisted(() => vi.fn());

vi.mock('~/lib/loop/voice/compose', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/lib/loop/voice/compose')>()),
  composeVoice,
  voiceClient: () => ({ messages: {} }),
}));

/**
 * Which system text the production composer hands the model. The words the model writes
 * are the eval's to judge (run-no-stop-keyword-eval.mjs).
 */

const FAMILY = '11111111-1111-4111-8111-111111111111';

/** One request per kind. A new kind fails the typecheck here until it is listed. */
const EVERY_KIND: { [K in GroupOnboardingKind]: Extract<GroupOnboardingRequest, { kind: K }> } = {
  roster_ask: { kind: 'roster_ask', knownParentName: 'Riley', rosterSize: 3 },
  member_ask: { kind: 'member_ask', knownParentName: 'Riley' },
  role_reask: { kind: 'role_reask' },
  role_confirmed: { kind: 'role_confirmed', name: 'Sam', role: 'dad' },
  no_family_yet: { kind: 'no_family_yet' },
  connect_link_1to1: {
    kind: 'connect_link_1to1',
    name: 'Sam',
    knownParentName: 'Riley',
    providers: ['Google Calendar', 'Gmail'],
  },
  text_me_directly: { kind: 'text_me_directly', name: 'Sam' },
  group_quiet_notice: { kind: 'group_quiet_notice', reason: 'unconfirmed', count: 1 },
  stop_ack: { kind: 'stop_ack' },
  member_welcome: { kind: 'member_welcome', adderName: 'Riley' },
  join_intro: {
    kind: 'join_intro',
    audience: 'household',
    knownParentName: 'Riley',
    adderName: null,
    claims: ['reads_this_chat'],
    ask: 'none',
  },
};

async function requestFor(request: GroupOnboardingRequest) {
  composeVoice.mockClear();
  composeVoice.mockImplementation(
    async (args: { context: { mustMention: string[]; questions: 0 | 1 } }) => ({
      voice: { line: `${args.context.mustMention.join(' ')}${args.context.questions ? '?' : '.'}` },
      degraded: false,
      reason: null,
    }),
  );
  await composeOnboardingLine({} as Database, {
    familyId: FAMILY,
    request,
    language: 'en',
    templateKey: 'test',
    voice: undefined,
  });
  return composeVoice.mock.calls[0]?.[0] as {
    systemExtras?: readonly string[];
    context: { mustMention: string[] };
  };
}

beforeEach(() => {
  vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
  vi.stubEnv('VOICE_DISABLED', 'false');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the keyword-free addendum on the group onboarding lane', () => {
  it('rides exactly the kinds that carry the way out, with the flag on', async () => {
    vi.stubEnv('NO_STOP_KEYWORD_COPY_ENABLED', 'true');
    const addendum = (await loadCronSkill('group-onboarding-no-keyword')).instructions;
    const carried: GroupOnboardingKind[] = [];
    for (const request of Object.values(EVERY_KIND)) {
      const sent = await requestFor(request);
      if (groupOnboardingLineInput(request, 'en').wayOut === true) {
        carried.push(request.kind);
        expect(sent.systemExtras).toEqual([addendum]);
      } else {
        expect(sent.systemExtras).toBeUndefined();
      }
    }
    expect(carried.sort()).toEqual(['connect_link_1to1', 'member_welcome', 'stop_ack']);
    expect((await requestFor(EVERY_KIND.connect_link_1to1)).context.mustMention).toEqual([
      'Hale',
      'Sam',
      'Riley',
    ]);
  });

  it('sends no addendum on any kind with the flag off, and the connect link keeps STOP', async () => {
    vi.stubEnv('NO_STOP_KEYWORD_COPY_ENABLED', 'false');
    for (const request of Object.values(EVERY_KIND)) {
      expect((await requestFor(request)).systemExtras).toBeUndefined();
    }
    expect((await requestFor(EVERY_KIND.connect_link_1to1)).context.mustMention).toEqual([
      'Hale',
      'Sam',
      'Riley',
      'STOP',
    ]);
  });
});

describe('the keyword gate on the lines that carry the way out', () => {
  const connect = groupOnboardingLineInput(EVERY_KIND.connect_link_1to1, 'en', { noKeyword: true });
  const stopAck = groupOnboardingLineInput(EVERY_KIND.stop_ack, 'en', { noKeyword: true });
  const memberStop = sharedGroupLineInput({ kind: 'member_stop', name: 'Jordan' }, 'en');

  const SURFACES: ReadonlyArray<[string, (wayOut: string, flagOn: boolean) => boolean]> = [
    [
      'connect_link_1to1',
      (wayOut, flagOn) => lineUsable(`Hale here for Sam and Riley. ${wayOut}`, connect, flagOn),
    ],
    ['stop_ack', (wayOut, flagOn) => lineUsable(`Heard you. ${wayOut}`, stopAck, flagOn)],
    [
      'member_stop',
      (wayOut, flagOn) => {
        vi.stubEnv('NO_STOP_KEYWORD_COPY_ENABLED', flagOn ? 'true' : 'false');
        return sharedLineUsable(`Got it Jordan. ${wayOut}`, memberStop);
      },
    ],
  ];

  describe.each(SURFACES)('%s', (_kind, usable) => {
    it.each([
      'You can text "stop."',
      'You can always tell me \u201cstop.\u201d',
      'If you are done, "stop," is enough.',
      'Tell me stop.',
      'Just tell me stop anytime.',
    ])('refuses %j with the flag on, and lets it through with the flag off', (wayOut) => {
      expect(usable(wayOut, true)).toBe(false);
      expect(usable(wayOut, false)).toBe(true);
    });

    it.each([
      'Tell me to stop anytime, in your own words.',
      'Tell me the start date.',
      'You can tell me anytime that you would like me to stop.',
    ])('sends %j with the flag on', (wayOut) => {
      expect(usable(wayOut, true)).toBe(true);
    });
  });
});
