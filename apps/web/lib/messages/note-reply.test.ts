import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageView } from '~/lib/messages/mappers';
import { SOURCE_NOTE_BODY_MAX, canReplyToNote, noteReplyRequest } from './note-reply';

/**
 * The web note-reply payload, and its ROUND TRIP through the real POST /api/coach
 * handler — the existing backend path a reply goes out on. The builder is asserted
 * against the route's own declared contract (its zod schema), not against whatever
 * it currently emits, and then actually pushed through that handler so a payload
 * the composer can build but the route would reject cannot ship.
 *
 * The agent itself is stubbed (rule #8 covers AGENT-BEHAVIOUR tests, which live in
 * the coach eval); what is under test here is orchestration — that the note anchor
 * and the already-redacted note view survive from the composer to askHale intact.
 */

const authMock = vi.fn();
const askHaleMock = vi.fn();

vi.mock('~/auth', () => ({ auth: () => authMock() }));
vi.mock('~/lib/db', () => ({ db: () => ({}) }));
vi.mock('~/lib/family', () => ({
  resolveFamilyForUser: vi.fn(async () => 'fam-1'),
  resolveUserIdForUser: vi.fn(async () => 'user-1'),
}));
vi.mock('~/lib/coach/agent', () => ({ askHale: (...a: unknown[]) => askHaleMock(...a) }));
vi.mock('~/lib/coach/attachments', () => ({
  loadUnlinkedAttachments: vi.fn(async () => []),
  MAX_ATTACHMENTS_PER_REQUEST: 5,
}));

const DIGEST: MessageView = {
  id: 'digest-11111111-1111-4111-8111-111111111111',
  kind: 'digest',
  eyebrow: 'Daily brief',
  body: 'Naps shortened this week — a common 4-month shift.',
  when: 'Today, 8:02 AM',
};

const REDACTED: MessageView = {
  id: 'action-22222222-2222-4222-8222-222222222222',
  kind: 'action',
  eyebrow: 'Private',
  body: 'Redacted · teen privacy',
  when: 'Yesterday, 6:15 PM',
  actionState: 'drafted_for_approval',
  teenRedacted: true,
};

function configureAuth(on: boolean) {
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', on ? 'gid_test' : '');
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', on ? 'gsecret_test' : '');
}

async function postReply(body: unknown) {
  const { POST } = await import('~/app/api/coach/route');
  return POST(
    new Request('http://localhost/api/coach', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

describe('canReplyToNote', () => {
  it('opens a reply on an ordinary Hale note', () => {
    expect(canReplyToNote(DIGEST)).toBe(true);
  });

  it('refuses a teen-redacted note — a parent never replies INTO withheld content (rule #1)', () => {
    expect(canReplyToNote(REDACTED)).toBe(false);
  });

  it('refuses a note whose id is not a note anchor the route would accept', () => {
    expect(canReplyToNote({ ...DIGEST, id: 'channel-sms:user-1' })).toBe(false);
  });
});

describe('noteReplyRequest', () => {
  it('anchors the reply to the note and seeds the note the parent is looking at', () => {
    expect(noteReplyRequest(DIGEST, '  what should I do about that?  ')).toEqual({
      question: 'what should I do about that?',
      noteKey: 'digest-11111111-1111-4111-8111-111111111111',
      sourceNote: {
        eyebrow: 'Daily brief',
        body: 'Naps shortened this week — a common 4-month shift.',
        when: 'Today, 8:02 AM',
      },
    });
  });

  it('bounds the seeded body to the route contract, so a long brief still sends', () => {
    const long = 'a'.repeat(SOURCE_NOTE_BODY_MAX + 500);
    const built = noteReplyRequest({ ...DIGEST, body: long }, 'why?');
    expect(built.sourceNote.body).toHaveLength(SOURCE_NOTE_BODY_MAX);
  });
});

describe('the built reply through the real POST /api/coach handler', () => {
  beforeEach(() => {
    vi.resetModules();
    authMock.mockReset();
    askHaleMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reaches askHale with the note anchor and the redacted note intact', async () => {
    configureAuth(true);
    authMock.mockResolvedValue({ user: { id: 'google-1' } });
    askHaleMock.mockResolvedValue({
      answer: 'shorter naps at four months usually settle in a fortnight.',
      conversationId: 'conv-note-1',
      actionIntents: [],
      metrics: { modelUsed: 'm', promptTokens: 1, completionTokens: 1, costUsd: 0.001, latencyMs: 5 },
    });

    const res = await postReply(noteReplyRequest(DIGEST, 'what should I do about that?'));

    expect(res.status).toBe(200);
    expect(askHaleMock).toHaveBeenCalledWith(
      expect.objectContaining({
        question: 'what should I do about that?',
        noteKey: 'digest-11111111-1111-4111-8111-111111111111',
        sourceNote: {
          eyebrow: 'Daily brief',
          body: 'Naps shortened this week — a common 4-month shift.',
          when: 'Today, 8:02 AM',
        },
      }),
      expect.anything(),
      undefined,
      expect.objectContaining({ onTextDelta: expect.any(Function) }),
    );
  });

  it('is accepted by the route even when the note body is longer than the schema allows', async () => {
    configureAuth(true);
    authMock.mockResolvedValue({ user: { id: 'google-1' } });
    askHaleMock.mockResolvedValue({
      answer: 'ok',
      conversationId: 'conv-note-2',
      actionIntents: [],
      metrics: { modelUsed: 'm', promptTokens: 1, completionTokens: 1, costUsd: 0.001, latencyMs: 5 },
    });

    const long = 'a'.repeat(SOURCE_NOTE_BODY_MAX + 500);
    const res = await postReply(noteReplyRequest({ ...DIGEST, body: long }, 'why?'));

    // Unclamped this is a 400 (`sourceNote.body` is capped at 4000) and the parent's
    // reply silently fails on exactly the longest briefs.
    expect(res.status).toBe(200);
    expect(askHaleMock).toHaveBeenCalled();
  });
});
