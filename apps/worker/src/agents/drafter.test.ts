import { markUntrusted } from '@hale/agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const create = vi.hoisted(() => vi.fn());

vi.mock('../anthropic/client.js', () => ({
  anthropicClient: () => ({ messages: { create } }),
}));

import { runDrafter } from './drafter.js';

const OUTPUT = {
  payload: { to: 'office@example.test', body: 'Thanks.' },
  confidence: 0.9,
  rationale: 'fixture',
  recipient_visibility: 'internal_only',
  commits_parent_to_enrollment_booking_or_payment: false,
};

function reply(request: { tools?: { name: string }[] }) {
  return {
    id: 'msg_drafter',
    type: 'message',
    role: 'assistant',
    model: 'claude-test',
    stop_reason: request.tools ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
    },
    content: request.tools
      ? [{ type: 'tool_use', id: 'tu_0', name: request.tools[0]?.name, input: OUTPUT }]
      : [{ type: 'text', text: JSON.stringify(OUTPUT) }],
  };
}

function sentPayload(): unknown {
  const request = create.mock.calls[0]?.[0] as { messages: { content: string }[] };
  const sent = JSON.parse(request.messages[0]?.content as string) as {
    event: { payload: unknown };
  };
  return sent.event.payload;
}

function draftFrom(source: string, eventType: string) {
  return runDrafter({
    familyId: 'fam-drafter',
    source,
    event: {
      eventId: 'event-drafter',
      eventType,
      payload: { title: 'Swim', notes: { parking: 'Lot B' }, attendees: 2 },
    },
    actionType: 'reply_to_email',
  });
}

/** The worker's draft stage: only the transport is scripted, and the REQUEST is what is read. */
describe('runDrafter — untrusted field marking (VIL-560)', () => {
  beforeEach(() => {
    create.mockReset();
    create.mockImplementation(async (request: { tools?: { name: string }[] }) => reply(request));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ['gcal', 'calendar_conflict_detected', 'calendar'],
    ['gcal', 'school_communication', 'calendar'],
    ['gmail', 'family_event_invite', 'email'],
    ['channel_sms', 'school_communication', 'other'],
  ] as const)('flag on: a %s row classified %s is marked as %s', async (source, type, label) => {
    vi.stubEnv('UNTRUSTED_FIELD_MARKING_ENABLED', 'true');

    await draftFrom(source, type);

    expect(sentPayload()).toBe(
      markUntrusted(
        label,
        'payload',
        JSON.stringify({ title: 'Swim', notes: { parking: 'Lot B' }, attendees: 2 }),
      ),
    );
  });

  it('flag off: the payload is the bytes production sends today', async () => {
    vi.stubEnv('UNTRUSTED_FIELD_MARKING_ENABLED', '');

    await draftFrom('gcal', 'calendar_conflict_detected');

    expect(sentPayload()).toEqual({
      title: 'Swim',
      notes: { parking: 'Lot B' },
      attendees: 2,
    });
  });
});
