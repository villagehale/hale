import type { Database } from '@hale/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadCronSkill } from '~/lib/cron/skill';
import {
  type GroupOnboardingKind,
  type GroupOnboardingRequest,
  groupOnboardingLineInput,
} from './group-onboarding-line-input';
import { composeOnboardingLine } from './group-onboarding-voice';

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
