import type { RegisteredTool, Skill } from '@hale/agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChannelTurn } from '~/lib/channel/router/coach-runtime';
import { groupPrivacyScopeEnabled, groupScopedContext } from './group-privacy-scope';
import { type ChannelCoachPorts, channelCoachRuntime } from './runtime';

const NOW = new Date('2026-10-25T16:00:00.000Z');
const SECRET_FACT = 'Maya sees Dr. Patel about anxiety on Thursdays';
const INBOX_LINE = 'Re: Invoice #4411 from Little Fins Swim';

const PRIVATE_CONTEXT = {
  question: 'hale when is swim this week?',
  transcript: [{ role: 'user' as const, content: 'hale when is swim this week?' }],
  children: [{ id: 'c1', stage: 'school_age', name: 'Maya', ageMonths: 96, teenRedacted: false }],
  memoryFacts: [
    {
      childId: 'c1',
      factType: 'health',
      factKey: 'therapy',
      factValue: SECRET_FACT,
      confidence: 1,
    },
  ],
  recentEpisodes: [
    { childId: null, occurredAt: NOW.toISOString(), episodeType: 'email', summary: INBOX_LINE },
  ],
  memoryBrief: {
    status: 'ready',
    text: `${SECRET_FACT}. ${INBOX_LINE}`,
    asOf: null,
    digestFreshness: 'fresh',
  },
  sourceNote: { eyebrow: 'Email', body: INBOX_LINE, when: 'today' },
};

afterEach(() => vi.unstubAllEnvs());

describe('VIL-439 group privacy scope', () => {
  it('is off unless the flag is exactly true', () => {
    expect(groupPrivacyScopeEnabled()).toBe(false);
    vi.stubEnv('GROUP_PRIVACY_SCOPE_ENABLED', 'on');
    expect(groupPrivacyScopeEnabled()).toBe(false);
    vi.stubEnv('GROUP_PRIVACY_SCOPE_ENABLED', 'true');
    expect(groupPrivacyScopeEnabled()).toBe(true);
  });

  it('drops memory, inbox-derived episodes, the brief, the source note and provider watch', () => {
    const scoped = groupScopedContext({
      ...PRIVATE_CONTEXT,
      providerWatch: [{ provider: 'x' }],
    } as never) as Record<string, unknown>;
    const text = JSON.stringify(scoped);
    expect(text).not.toContain(SECRET_FACT);
    expect(text).not.toContain(INBOX_LINE);
    expect(scoped).not.toHaveProperty('providerWatch');
    expect(scoped.sourceNote).toBeNull();
    // What the group already shares stays: this chat and the kids it talks about.
    expect(text).toContain('hale when is swim this week?');
    expect(text).toContain('Maya');
  });

  describe('in the runtime', () => {
    const SKILL: Skill = {
      meta: { name: 'coach-channel-sms', whenToUse: 'x', task: 'converse', tools: [] },
      instructions: 'be terse',
    };
    function turn(audience: 'group' | 'direct'): ChannelTurn {
      return {
        familyId: '11111111-1111-4111-8111-111111111111',
        parentUserId: '22222222-2222-4222-8222-222222222222',
        conversationId: '33333333-3333-4333-8333-333333333333',
        body: PRIVATE_CONTEXT.question,
        now: NOW,
        standingQuestions: [],
        audience,
      };
    }
    function ports(seen: string[]): ChannelCoachPorts {
      return {
        loadSkill: async () => SKILL,
        loadTranscript: async () => PRIVATE_CONTEXT.transcript,
        loadContext: async () => PRIVATE_CONTEXT as never,
        loadChildren: async () => [],
        loadRegistrationWindows: async () => [],
        buildTools: () => [] as RegisteredTool[],
        nearbySaid: async () => null,
        guardDeps: { async writeAudit() {} },
        client: () => ({ messages: {} }) as never,
        runAgent: async (args) => {
          seen.push(JSON.stringify(args.context));
          return {
            answer: 'Swim is Tuesday at 4:30.',
            steps: 1,
            hitMaxSteps: false,
            truncatedRetries: 0,
            truncated: false,
            usage: {
              promptTokens: 1,
              cacheCreationTokens: 0,
              cacheReadTokens: 0,
              completionTokens: 1,
            },
          };
        },
        recordRun: async () => {},
        now: () => NOW,
      };
    }

    it('flag on: a group turn never hands private context to the model', async () => {
      vi.stubEnv('GROUP_PRIVACY_SCOPE_ENABLED', 'true');
      const seen: string[] = [];
      await channelCoachRuntime(ports(seen)).respond(turn('group'), []);
      expect(seen[0]).not.toContain(SECRET_FACT);
      expect(seen[0]).not.toContain(INBOX_LINE);
    });

    it('flag on: a 1:1 turn is untouched', async () => {
      vi.stubEnv('GROUP_PRIVACY_SCOPE_ENABLED', 'true');
      const seen: string[] = [];
      await channelCoachRuntime(ports(seen)).respond(turn('direct'), []);
      expect(seen[0]).toContain(SECRET_FACT);
    });

    it("flag off: today's group context is byte-identical", async () => {
      const seen: string[] = [];
      await channelCoachRuntime(ports(seen)).respond(turn('group'), []);
      expect(seen[0]).toContain(SECRET_FACT);
    });
  });
});
