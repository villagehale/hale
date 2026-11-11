import type Anthropic from '@anthropic-ai/sdk';
import type { AgentClient } from '@hale/agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import {
  INBOUND_PHOTO_FACTS_ENABLED_ENV,
  augmentCoachSkillForPhotoFacts,
  extractInboundPhotoFacts,
  inboundPhotoFactsEnabled,
  inboundPhotoFactsUserMessage,
  photoFactSignupLinks,
  validateInboundPhotoFacts,
} from './inbound-photo-facts';

const JPEG: Anthropic.ContentBlockParam = {
  type: 'image',
  source: { type: 'base64', media_type: 'image/jpeg', data: 'abc' },
};

const FLYER = {
  kind: 'flyer' as const,
  title: 'Fall swim',
  venue: 'Harbor Rec',
  when_text: 'Tuesdays 4:30',
  registration_url: 'https://harbor-rec.example/register',
  child_name: null,
  notes: 'ages 6-8',
  confidence: 0.9,
};

type SentRequest = { messages: Array<{ content: unknown }> };

function scriptedClient(input: Record<string, unknown>): {
  client: AgentClient;
  requests: SentRequest[];
} {
  const requests: SentRequest[] = [];
  const client = {
    messages: {
      // biome-ignore lint/suspicious/noExplicitAny: a scripted stand-in for the model
      async create(req: any) {
        requests.push(req);
        return {
          content: [{ type: 'text', text: JSON.stringify(input) }],
          usage: { input_tokens: 10, output_tokens: 5 },
          stop_reason: 'end_turn',
        };
      },
    },
  } as unknown as AgentClient;
  return { client, requests };
}

describe('inboundPhotoFactsEnabled', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is on for exactly the literal "true", through the launch-flag catalog', () => {
    vi.stubEnv(INBOUND_PHOTO_FACTS_ENABLED_ENV, 'true');
    expect(inboundPhotoFactsEnabled()).toBe(true);
  });

  it('fails closed on unset, a piped newline, and every other spelling', () => {
    for (const value of ['', 'true\n', 'TRUE', '1', 'on', ' true', 'true ']) {
      vi.stubEnv(INBOUND_PHOTO_FACTS_ENABLED_ENV, value);
      expect(inboundPhotoFactsEnabled(), JSON.stringify(value)).toBe(false);
    }
  });
});

describe('validateInboundPhotoFacts', () => {
  it('keeps a flyer and the public registration URL', () => {
    expect(validateInboundPhotoFacts(FLYER)).toEqual({
      kind: 'flyer',
      title: 'Fall swim',
      venue: 'Harbor Rec',
      whenText: 'Tuesdays 4:30',
      registrationUrl: 'https://harbor-rec.example/register',
      childName: null,
      notes: 'ages 6-8',
      confidence: 0.9,
    });
  });

  it('drops an unreadable page, an empty page, and a URL that is not a public page', () => {
    expect(validateInboundPhotoFacts({ ...FLYER, kind: 'unreadable' })).toBeNull();
    expect(
      validateInboundPhotoFacts({
        kind: 'other',
        title: null,
        venue: null,
        when_text: '  ',
        registration_url: null,
        child_name: null,
        notes: null,
        confidence: 0.2,
      }),
    ).toBeNull();
    for (const url of [
      'javascript:alert(1)',
      'http://harbor-rec.example/register',
      'http://localhost:3000/register',
      'https://192.168.1.10/register',
      'https://user:pw@harbor-rec.example/register',
    ]) {
      expect(
        validateInboundPhotoFacts({ ...FLYER, registration_url: url })?.registrationUrl,
        url,
      ).toBeNull();
    }
  });

  it('drops a page field whole when it carries a way to reach someone (VIL-633)', () => {
    const facts = validateInboundPhotoFacts({
      ...FLYER,
      title: 'Fall swim, text 416-555-0199',
      venue: 'Harbor Rec, see harbor-rec.example',
      notes: 'questions: coach@harbor-rec.example',
      child_name: 'Ada (at) evil (dot) app',
    });
    expect(facts).toMatchObject({
      title: null,
      venue: null,
      notes: null,
      childName: null,
      whenText: 'Tuesdays 4:30',
      registrationUrl: 'https://harbor-rec.example/register',
    });
    expect(photoFactSignupLinks(facts)).toEqual([
      {
        title: 'https://harbor-rec.example/register',
        url: 'https://harbor-rec.example/register',
      },
    ]);
  });

  it('keeps a schedule date with its clock, and drops one that carries a phone', () => {
    expect(
      validateInboundPhotoFacts({ ...FLYER, when_text: 'Sat Sept 12 2026, 10:00-10:45' })?.whenText,
    ).toBe('Sat Sept 12 2026, 10:00-10:45');
    expect(
      validateInboundPhotoFacts({ ...FLYER, when_text: 'Tuesdays, call 416 555 0199' })?.whenText,
    ).toBeNull();
  });

  it('reads each field as one line', () => {
    expect(validateInboundPhotoFacts({ ...FLYER, title: 'Fall\n\n  swim ' })?.title).toBe(
      'Fall swim',
    );
  });
});

describe('photoFactSignupLinks', () => {
  it('hands offer_signup only a URL Hale already saw', () => {
    const facts = validateInboundPhotoFacts(FLYER);
    expect(photoFactSignupLinks(facts)).toEqual([
      { title: 'Fall swim', url: 'https://harbor-rec.example/register' },
    ]);
    expect(photoFactSignupLinks(null)).toEqual([]);
    expect(
      photoFactSignupLinks(validateInboundPhotoFacts({ ...FLYER, registration_url: null })),
    ).toEqual([]);
  });
});

describe('augmentCoachSkillForPhotoFacts', () => {
  it('returns the same skill object when there is no addendum', () => {
    const skill = {
      instructions: 'be terse',
      meta: { name: 'coach-channel-sms', whenToUse: 'x', task: 'converse' as const, tools: [] },
    };
    expect(augmentCoachSkillForPhotoFacts(skill, null)).toBe(skill);
  });
});

describe('extractInboundPhotoFacts', () => {
  it('does not call the model when there is nothing to read', async () => {
    const { client, requests } = scriptedClient(FLYER);
    expect(
      await extractInboundPhotoFacts({
        client,
        blocks: [],
        parentWords: 'can you read this',
        now: new Date('2026-11-10T18:00:00Z'),
        timeZone: 'America/Toronto',
      }),
    ).toBeNull();
    expect(requests).toEqual([]);
  });

  it('sends the image blocks and returns the validated facts', async () => {
    const { client, requests } = scriptedClient(FLYER);
    const input = {
      client,
      blocks: [JPEG],
      parentWords: 'can you read this',
      now: new Date('2026-11-10T18:00:00Z'),
      timeZone: 'America/Toronto',
    };
    const facts = await extractInboundPhotoFacts(input);
    expect(facts?.title).toBe('Fall swim');
    expect(facts?.registrationUrl).toBe('https://harbor-rec.example/register');
    const content = requests[0]?.messages[0]?.content as unknown[];
    expect(content[0]).toEqual({
      type: 'text',
      text: inboundPhotoFactsUserMessage(input),
    });
    expect(content[1]).toEqual(JPEG);
  });

  it('fails the read when a field runs past its bound, instead of carrying the page on', async () => {
    const { client } = scriptedClient({ ...FLYER, notes: 'x'.repeat(241) });
    await expect(
      extractInboundPhotoFacts({
        client,
        blocks: [JPEG],
        parentWords: '',
        now: new Date('2026-11-10T18:00:00Z'),
        timeZone: null,
      }),
    ).rejects.toBeInstanceOf(ZodError);
  });
});
