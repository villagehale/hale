import type { AgentClient } from '@hale/agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { linqGroupMentionsEnabled } from './config';
import {
  createGroupMentionReader,
  groupMentionUserMessage,
  inboundMentionFacts,
  resolveGroupMention,
} from './group-mention-reader';

vi.mock('~/lib/pipeline/structured', () => ({ forceToolJson: vi.fn() }));
vi.mock('~/lib/cron/skill', () => ({
  loadCronSkill: async () => ({
    meta: { name: 'group-mention-read', whenToUse: 'x', task: 'screen', tools: [] },
    instructions: 'read',
  }),
}));

const { forceToolJson } = await import('~/lib/pipeline/structured');
const CLIENT = {} as AgentClient;
const DANA = {
  id: 'm1',
  name: 'Dana',
  role: 'parent',
  handle: '+14155551234',
};
const JORDAN = {
  id: 'm2',
  name: 'Jordan',
  role: 'co_parent',
  handle: '+14155559876',
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(forceToolJson).mockReset();
});

function keysUnset() {
  expect(process.env.LINQ_API_KEY ?? '').toBe('');
  expect(process.env.ANTHROPIC_API_KEY ?? '').toBe('');
  expect(process.env.AI_GATEWAY_API_KEY ?? '').toBe('');
  expect(process.env.BROWSER_USE_API_KEY ?? '').toBe('');
  // vitest.setup.ts injects this dummy so load-time env reads do not throw.
  // Nothing here connects. A real DATABASE_URL is not allowed.
  const db = process.env.DATABASE_URL ?? '';
  expect(db === '' || db === 'postgres://test:test@localhost:5432/test').toBe(true);
}

describe('LINQ_GROUP_MENTIONS_ENABLED', () => {
  it('is on only when the flag is exactly true', () => {
    keysUnset();
    expect(linqGroupMentionsEnabled()).toBe(false);
    vi.stubEnv('LINQ_GROUP_MENTIONS_ENABLED', 'true');
    expect(linqGroupMentionsEnabled()).toBe(true);
    vi.stubEnv('LINQ_GROUP_MENTIONS_ENABLED', 'on');
    expect(linqGroupMentionsEnabled()).toBe(false);
    vi.stubEnv('LINQ_GROUP_MENTIONS_ENABLED', '');
    expect(linqGroupMentionsEnabled()).toBe(false);
  });
});

describe('inboundMentionFacts', () => {
  it('uses Linq is_me and seated names, never a word in the text', () => {
    keysUnset();
    expect(
      inboundMentionFacts(
        [
          { handle: '+14155551234', isMe: false },
          { handle: '+14155550100', isMe: true },
        ],
        [DANA, JORDAN],
      ),
    ).toEqual({
      haleMentioned: true,
      mentionedMembers: [{ name: 'Dana' }],
    });
  });

  it('keeps a named-but-unseated handle as a member without a name', () => {
    keysUnset();
    expect(inboundMentionFacts([{ handle: '+14155550999', isMe: false }], [DANA])).toEqual({
      haleMentioned: false,
      mentionedMembers: [{ name: null }],
    });
  });
});

describe('group mention reader', () => {
  it('hands the model names and roles, not handles', () => {
    keysUnset();
    const payload = JSON.parse(
      groupMentionUserMessage({
        text: 'Swim is at 4.',
        members: [
          { id: DANA.id, name: DANA.name, role: DANA.role },
          { id: JORDAN.id, name: JORDAN.name, role: JORDAN.role },
        ],
        inbound: { haleMentioned: true, mentionedMembers: [] },
      }),
    );
    expect(JSON.stringify(payload)).not.toContain('+1415');
    expect(payload.members).toEqual([
      { id: 'm1', name: 'Dana', role: 'parent' },
      { id: 'm2', name: 'Jordan', role: 'co_parent' },
    ]);
  });

  it('returns the model mention id', async () => {
    keysUnset();
    vi.mocked(forceToolJson).mockResolvedValue({ value: { mentionId: 'm1' } } as never);
    expect(
      await createGroupMentionReader(CLIENT).read({
        text: 'Swim is at 4.',
        members: [{ id: DANA.id, name: DANA.name, role: DANA.role }],
        inbound: { haleMentioned: false, mentionedMembers: [] },
      }),
    ).toBe('m1');
  });

  it('survives a thrown model call and names nobody', async () => {
    keysUnset();
    vi.mocked(forceToolJson).mockRejectedValue(new Error('boom'));
    expect(
      await createGroupMentionReader(CLIENT).read({
        text: 'Swim is at 4.',
        members: [{ id: DANA.id, name: DANA.name, role: DANA.role }],
        inbound: { haleMentioned: false, mentionedMembers: [] },
      }),
    ).toBeNull();
  });
});

describe('resolveGroupMention', () => {
  const database = {} as never;

  it('sends no mention while the flag is off', async () => {
    keysUnset();
    const reader = { read: vi.fn(async () => 'm1') };
    expect(
      await resolveGroupMention({
        database,
        chatId: 'chat-1',
        text: 'Swim is at 4.',
        reader,
        members: [DANA],
      }),
    ).toBeUndefined();
    expect(reader.read).not.toHaveBeenCalled();
  });

  it('returns the seated handle the reader named, and nothing for an unknown id', async () => {
    keysUnset();
    vi.stubEnv('LINQ_GROUP_MENTIONS_ENABLED', 'true');
    expect(
      await resolveGroupMention({
        database,
        chatId: 'chat-1',
        text: 'Swim is at 4.',
        reader: { read: async () => 'm1' },
        members: [DANA, JORDAN],
      }),
    ).toBe('+14155551234');
    expect(
      await resolveGroupMention({
        database,
        chatId: 'chat-1',
        text: 'Swim is at 4.',
        reader: { read: async () => 'm-missing' },
        members: [DANA],
      }),
    ).toBeUndefined();
  });

  it('sends no mention when the reader names nobody', async () => {
    keysUnset();
    vi.stubEnv('LINQ_GROUP_MENTIONS_ENABLED', 'true');
    expect(
      await resolveGroupMention({
        database,
        chatId: 'chat-1',
        text: 'Swim is at 4.',
        reader: { read: async () => null },
        members: [DANA],
      }),
    ).toBeUndefined();
  });
});
