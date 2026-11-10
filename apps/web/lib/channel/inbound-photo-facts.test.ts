import type Anthropic from '@anthropic-ai/sdk';
import type { AgentClient } from '@hale/agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
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

function scriptedClient(input: Record<string, unknown>): {
  client: AgentClient;
  requests: Array<Record<string, unknown>>;
} {
  const requests: Array<Record<string, unknown>> = [];
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

  it('is off unless the value is exactly true, with no trim', () => {
    expect(inboundPhotoFactsEnabled({})).toBe(false);
    expect(inboundPhotoFactsEnabled({ INBOUND_PHOTO_FACTS_ENABLED: 'true' })).toBe(true);
    expect(inboundPhotoFactsEnabled({ INBOUND_PHOTO_FACTS_ENABLED: 'true\n' })).toBe(false);
    expect(inboundPhotoFactsEnabled({ INBOUND_PHOTO_FACTS_ENABLED: 'TRUE' })).toBe(false);
    expect(inboundPhotoFactsEnabled({ INBOUND_PHOTO_FACTS_ENABLED: ' on ' })).toBe(false);
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
    expect(
      validateInboundPhotoFacts({
        ...FLYER,
        registration_url: 'javascript:alert(1)',
        title: 'Fall swim',
      })?.registrationUrl,
    ).toBeNull();
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
        audience: 'direct',
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
      audience: 'direct' as const,
    };
    const facts = await extractInboundPhotoFacts(input);
    expect(facts?.title).toBe('Fall swim');
    expect(facts?.registrationUrl).toBe('https://harbor-rec.example/register');
    const content = (requests[0]?.messages as { content?: unknown }[] | undefined)?.[0]
      ?.content as unknown[];
    expect(content[0]).toEqual({
      type: 'text',
      text: inboundPhotoFactsUserMessage(input),
    });
    expect(content[1]).toEqual(JPEG);
  });
});
