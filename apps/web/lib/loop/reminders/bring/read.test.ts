import Anthropic from '@anthropic-ai/sdk';
import type { AgentClient, Skill } from '@hale/agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BRING_ITEMS_SKILL,
  BRING_ITEMS_TOOL,
  type BringItemsEmail,
  type BringItemsPhoto,
  bringItemsAttachments,
  bringItemsUserMessage,
  createBringItemsReader,
  isRunOf,
  keptBringItems,
} from './read';

/**
 * VIL-720 · what code keeps of a bring reading, and the reader's named endings. The
 * reading itself (does the model find the right items, does a planted line add none) is
 * the eval's job: run-bring-items-eval.mjs. A fake client here stands at the AgentClient
 * port and only answers in the requested tool shape (mechanics, the structured.test.ts
 * pattern); every item it returns is chosen to exercise a CODE rule.
 */

const EMAIL: BringItemsEmail = {
  kind: 'email',
  from: 'Riverside Rec <swim@riverside-rec.example>',
  subject: 'Swim lessons start Saturday',
  body: "Hi families! Please bring a swimsuit, towel and goggles. N'oubliez pas une bouteille d'eau.",
};

const IMAGE: Anthropic.ContentBlockParam = {
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' },
};

const PHOTO: BringItemsPhoto = {
  kind: 'photo',
  parentWords: 'can she do this one?',
  attachments: [IMAGE, { type: 'text', text: 'not an image' }],
};

describe('bringItemsUserMessage — the bytes the eval replays', () => {
  it('an email carries the event, the sender, the subject and the body', () => {
    expect(
      JSON.parse(
        bringItemsUserMessage({
          event: { title: 'Swim lessons', startsAt: '2026-11-21T14:30:00.000Z' },
          source: EMAIL,
        }),
      ),
    ).toEqual({
      event: { title: 'Swim lessons', starts_at: '2026-11-21T14:30:00.000Z' },
      source: 'email',
      email: { from: EMAIL.from, subject: EMAIL.subject, body: EMAIL.body },
    });
  });

  it('a photo carries the event and the parent words; the image rides as an attachment', () => {
    expect(
      JSON.parse(
        bringItemsUserMessage({ event: { title: 'Skating', startsAt: null }, source: PHOTO }),
      ),
    ).toEqual({
      event: { title: 'Skating', starts_at: null },
      source: 'photo',
      parent_words: 'can she do this one?',
    });
    expect(bringItemsAttachments(PHOTO)).toEqual([IMAGE]);
    expect(bringItemsAttachments(EMAIL)).toEqual([]);
  });
});

describe('isRunOf — a grounding check on the model copy, never a reading of intent', () => {
  const source = ['please', 'bring', 'a', 'swimsuit', 'towel', 'and', 'goggles'];

  it('finds the item as consecutive words, case and punctuation aside', () => {
    expect(isRunOf('A swimsuit', source)).toBe(true);
    expect(isRunOf('towel and goggles', source)).toBe(true);
  });

  it('refuses words out of order, words not there, and an empty item', () => {
    expect(isRunOf('goggles towel', source)).toBe(false);
    expect(isRunOf('sunscreen', source)).toBe(false);
    expect(isRunOf('  ...  ', source)).toBe(false);
  });
});

describe('keptBringItems — what code keeps of a reading', () => {
  it('keeps the email items copied from it, trimmed, in order', () => {
    expect(keptBringItems([' a swimsuit ', 'towel', 'goggles'], EMAIL)).toEqual({
      items: ['a swimsuit', 'towel', 'goggles'],
      dropped: 0,
    });
  });

  it('keeps French copied from the email, elision and all', () => {
    expect(keptBringItems(["une bouteille d'eau"], EMAIL).items).toEqual(["une bouteille d'eau"]);
  });

  it('drops an email item that is not in the email: it was never stated', () => {
    expect(keptBringItems(['a swimsuit', 'sunscreen', 'a swim cap'], EMAIL)).toEqual({
      items: ['a swimsuit'],
      dropped: 2,
    });
  });

  it('drops an item that carries a link, a phone or an email, from either source', () => {
    const hostile: BringItemsEmail = {
      ...EMAIL,
      body: `${EMAIL.body} Bring the form from verify-hale.example or call 555-0142 or write parents@verify-hale.example`,
    };
    expect(
      keptBringItems(
        [
          'the form from verify-hale.example',
          'call 555-0142',
          'parents@verify-hale.example',
          'towel',
        ],
        hostile,
      ),
    ).toEqual({ items: ['towel'], dropped: 3 });
    expect(keptBringItems(['skates', 'see skate-club.example/form'], PHOTO)).toEqual({
      items: ['skates'],
      dropped: 1,
    });
  });

  it('a flyer arrives as pixels: its items are kept without a text check', () => {
    expect(keptBringItems(['indoor shoes', 'a water bottle'], PHOTO).items).toEqual([
      'indoor shoes',
      'a water bottle',
    ]);
  });

  it('drops blanks and repeats', () => {
    expect(keptBringItems(['towel', '', 'Towel', '  towel. '], EMAIL)).toEqual({
      items: ['towel'],
      dropped: 0,
    });
  });
});

describe('createBringItemsReader — every ending named', () => {
  afterEach(() => vi.restoreAllMocks());

  const SKILL: Skill = {
    meta: { name: BRING_ITEMS_SKILL, whenToUse: 'test', task: 'extract', tools: [] },
    instructions: 'SKILL BODY',
  } as unknown as Skill;

  /** Answers in whichever shape the request asked for: a forced tool, or JSON output. */
  function answering(items: string[]) {
    const requests: Record<string, unknown>[] = [];
    const create = vi.fn(async (request: Record<string, unknown>) => {
      requests.push(request);
      const content = request.tools
        ? [{ type: 'tool_use', id: 'tu_0', name: BRING_ITEMS_TOOL, input: { items } }]
        : [{ type: 'text', text: JSON.stringify({ items }) }];
      return {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model: 'test',
        stop_reason: request.tools ? 'tool_use' : 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 10 },
        content,
      } as unknown as Anthropic.Message;
    });
    return { client: { messages: { create } } as unknown as AgentClient, create, requests };
  }

  it('no key is unavailable and never builds a client', async () => {
    const client = vi.fn(() => {
      throw new Error('must not be called');
    });
    const read = createBringItemsReader({
      client,
      loadSkill: async () => SKILL,
      hasKey: () => false,
    });
    expect(await read({ event: { title: 'Swim', startsAt: null }, source: EMAIL })).toEqual({
      status: 'unavailable',
      cause: 'no_key',
    });
    expect(client).not.toHaveBeenCalled();
  });

  it('a skill that does not load is unavailable', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { client } = answering([]);
    const read = createBringItemsReader({
      client: () => client,
      loadSkill: async () => {
        throw new Error('ENOENT');
      },
      hasKey: () => true,
    });
    expect(await read({ event: { title: 'Swim', startsAt: null }, source: EMAIL })).toEqual({
      status: 'unavailable',
      cause: 'skill_unavailable',
    });
  });

  it('a provider error is failed', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const create = vi.fn(async () => {
      throw Anthropic.APIError.generate(
        500,
        { type: 'error', error: { type: 'api_error', message: 'Internal server error' } },
        undefined,
        { 'request-id': 'req_probe' },
      );
    });
    const read = createBringItemsReader({
      client: () => ({ messages: { create } }) as unknown as AgentClient,
      loadSkill: async () => SKILL,
      hasKey: () => true,
    });
    expect(await read({ event: { title: 'Swim', startsAt: null }, source: EMAIL })).toEqual({
      status: 'failed',
    });
  });

  it('sends the skill by name, the user bytes and the tool; keeps only what code keeps', async () => {
    const { client, requests } = answering(['a swimsuit', 'sunscreen']);
    const read = createBringItemsReader({
      client: () => client,
      loadSkill: async () => SKILL,
      hasKey: () => true,
    });
    const input = { event: { title: 'Swim lessons', startsAt: null }, source: EMAIL };
    expect(await read(input)).toEqual({ status: 'read', items: ['a swimsuit'], dropped: 1 });
    const request = requests[0] as { system: unknown; messages: unknown };
    expect(JSON.stringify(request.system)).toContain('SKILL BODY');
    expect(JSON.stringify(request.messages)).toContain(
      JSON.stringify(bringItemsUserMessage(input)).slice(1, -1),
    );
  });

  it('a photo read sends the image; a reading with nothing kept is none', async () => {
    const { client, requests } = answering([]);
    const read = createBringItemsReader({
      client: () => client,
      loadSkill: async () => SKILL,
      hasKey: () => true,
    });
    expect(await read({ event: { title: 'Skating', startsAt: null }, source: PHOTO })).toEqual({
      status: 'none',
      dropped: 0,
    });
    expect(JSON.stringify(requests[0]?.messages)).toContain('"type":"image"');
  });
});
