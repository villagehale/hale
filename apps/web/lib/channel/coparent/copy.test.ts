import type { AgentClient } from '@hale/agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CoParentRefusal } from '~/lib/channel/caregiver/invites';
import { createSpokenLineWriter, setSharedSpokenLineWriter } from '~/lib/channel/spoken-line';
import { scriptedSpokenLineWriter } from '~/lib/testing/spoken-line.fixture';
import {
  coParentDeclineAck,
  coParentDepartedNotice,
  coParentInviteDroppedAck,
  coParentInviteExpired,
  coParentInviteSentAck,
  coParentReferrerUnnamed,
  coParentRefusal,
  coParentSeatTakenLate,
  coParentUnavailable,
  coParentWelcome,
  inviterNameIsAffordable,
} from './copy';

/**
 * The scripted model writes these lines. The product no longer keeps a
 * sentence table. A name the alphabet cannot carry is still refused before
 * a cold text goes out.
 */

const LONGEST_NAME = 'Marie-Claude Bergeron-Ly';

describe('co-parent copy', () => {
  it('writes a welcome in the language asked, and a different one in French', async () => {
    const en = await coParentWelcome(LONGEST_NAME, 'en');
    const fr = await coParentWelcome(LONGEST_NAME, 'fr');
    expect(en).toBeTruthy();
    expect(fr).toBeTruthy();
    expect(fr).not.toBe(en);
    expect(en).toContain(LONGEST_NAME);
    expect(fr).toContain(LONGEST_NAME);
  });

  it('refuses a name the GSM-7 alphabet cannot carry, and accepts one it can', () => {
    expect(inviterNameIsAffordable(LONGEST_NAME)).toBe(true);
    expect(inviterNameIsAffordable('Zoë')).toBe(false);
    expect(inviterNameIsAffordable('李明')).toBe(false);
    expect(inviterNameIsAffordable('François')).toBe(false);
    expect(inviterNameIsAffordable(null)).toBe(false);
    expect(inviterNameIsAffordable('   ')).toBe(false);
    expect(inviterNameIsAffordable('A'.repeat(25))).toBe(false);
  });

  it('does not name whose account a busy number belongs to', async () => {
    for (const language of ['en', 'fr'] as const) {
      const body = await coParentRefusal('number_in_use', language);
      expect(body).toBeTruthy();
      expect(body).not.toMatch(/family|famille|their|leur/);
    }
  });

  it('writes a French refusal that is not the English one', async () => {
    const reasons: CoParentRefusal[] = [
      'referrer_unnamed',
      'number_in_use',
      'co_parent_seat_taken',
      'previously_declined',
    ];
    for (const reason of reasons) {
      const en = await coParentRefusal(reason, 'en');
      const fr = await coParentRefusal(reason, 'fr');
      expect(en).toBeTruthy();
      expect(fr).not.toBe(en);
    }
    expect(await coParentDeclineAck('fr')).not.toBe(await coParentDeclineAck('en'));
    expect(await coParentReferrerUnnamed('fr')).not.toBe(await coParentReferrerUnnamed('en'));
  });

  it('writes the expired invite and the departure notice without a placeholder', async () => {
    for (const language of ['en', 'fr'] as const) {
      const expired = await coParentInviteExpired(language);
      const departed = await coParentDepartedNotice(language);
      expect(expired).toBeTruthy();
      expect(departed).toBeTruthy();
      expect(departed).not.toMatch(/\$\{|\{\{/);
      expect(departed?.toLowerCase()).toContain('co-parent');
    }
    expect(await coParentDepartedNotice('fr')).not.toBe(await coParentDepartedNotice('en'));
  });
});

describe('VIL-706 · the co-parent door lines refuse an opt-out keyword with the door flag lit', () => {
  afterEach(() => {
    setSharedSpokenLineWriter(scriptedSpokenLineWriter);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  /** The client port handing back one fixed draft, so the real writer's acceptance runs. */
  function writerDrafting(text: string) {
    const client = (): AgentClient =>
      ({
        messages: {
          create: async () => ({
            // Both shapes, so the stub does not depend on which the lane's request uses.
            content: [
              { type: 'text', text: JSON.stringify({ text }) },
              { type: 'tool_use', id: 'draft', name: 'spoken_line', input: { text } },
            ],
            stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        },
      }) as unknown as AgentClient;
    return createSpokenLineWriter(client, { page: async () => 'paged' });
  }

  const LINES: Array<[string, () => Promise<string | null>]> = [
    ['welcome', () => coParentWelcome('Ana', 'en')],
    ['decline ack', () => coParentDeclineAck('en')],
    ['invite sent', () => coParentInviteSentAck('Ana', 'en')],
    ['invite dropped', () => coParentInviteDroppedAck('Ana', 'en')],
    ['refusal', () => coParentRefusal('own_number', 'en')],
    ['referrer unnamed', () => coParentReferrerUnnamed('en')],
    ['unavailable', () => coParentUnavailable('en')],
    ['seat taken late', () => coParentSeatTakenLate('en')],
    ['departed notice', () => coParentDepartedNotice('en')],
    ['invite expired', () => coParentInviteExpired('en')],
  ];

  it.each(LINES)('lit: %s drafted with a keyword is not sent', async (_name, line) => {
    vi.stubEnv('JOIN_DOOR_MODEL_COPY_ENABLED', 'true');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    setSharedSpokenLineWriter(writerDrafting('Thanks, all set. Reply STOP anytime.'));
    await expect(line()).resolves.toBeNull();
  });

  it.each(LINES)('lit: %s in plain words goes out (positive control)', async (_name, line) => {
    vi.stubEnv('JOIN_DOOR_MODEL_COPY_ENABLED', 'true');
    const plain = 'Thanks, all set. Tell me if you would rather I stop.';
    setSharedSpokenLineWriter(writerDrafting(plain));
    await expect(line()).resolves.toBe(plain);
  });

  it.each(LINES)('dark: %s keeps the acceptance it has today', async (_name, line) => {
    vi.stubEnv('JOIN_DOOR_MODEL_COPY_ENABLED', '');
    const draft = 'Thanks, all set. Reply STOP anytime.';
    setSharedSpokenLineWriter(writerDrafting(draft));
    await expect(line()).resolves.toBe(draft);
  });
});
