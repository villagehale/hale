import type { Database } from '@hale/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeTransport } from '~/lib/channel/intake/transport';
import {
  type FollowUpDelivery,
  type FollowUpDeliveryInput,
  type FollowUpRecipient,
  deliverFollowUp,
  noEvidence,
  textSlots,
  watchWarranted,
} from './deliver';
import type { FollowUpPick } from './followup-note';

/**
 * IS THERE ANYTHING LEFT TO COME BACK FOR — the decision behind the watch row.
 *
 * It is read off the TOP pick, because the top pick is what the text leads with, and it
 * decides two things at once: whether Hale writes a continuation promise, and whether the
 * message is allowed to say it will come back. Every case here is a `price` or a `when` a
 * live extract really returned.
 */
function pick(over: Partial<FollowUpPick> = {}): FollowUpPick {
  return {
    name: 'Tiny Gym, Cartwheels Gym Centre',
    ageFit: 'walking to 3.5 years',
    when: 'Sundays 9:30-10:15, Sept 14 to Oct 26',
    price: '$124 per term',
    registration: null,
    sourceName: 'Cartwheels Gym Centre',
    source: 'web',
    ...over,
  };
}

describe('watchWarranted', () => {
  it('is false for a find that carries both a day and a price', () => {
    expect(watchWarranted([pick()])).toBe(false);
  });

  it('is true with nothing found at all', () => {
    expect(watchWarranted([])).toBe(true);
  });

  it('is true when a field explains its own absence instead of being one', () => {
    // Live 2026-08-22, the venue this whole arc is named after.
    expect(
      watchWarranted([
        pick({
          price:
            'Not listed on main site; pricing varies by term length and is only visible after logging into the Registration Website',
        }),
      ]),
    ).toBe(true);
  });

  it('THE POLITE NON-ANSWER: a sentence about where a price lives is not a price', () => {
    // Live 2026-08-24. This claims no absence at all - it is perfectly cheerful - and it
    // answers nothing. It passed only because the old absence regex matched the "nt" in
    // "current"; once that bug was fixed Hale began handing it over as a complete find
    // with no follow-up behind it, and the parent had neither a price nor a promise.
    expect(
      watchWarranted([
        pick({ price: 'Fees set by Council each year, published in the current Recreation Guide' }),
      ]),
    ).toBe(true);
    expect(watchWarranted([pick({ when: 'Fall session, dates to be confirmed' })])).toBe(true);
  });

  it('FREE IS A PRICE - and demanding a figure made five free drop-ins look unanswered', () => {
    // Measured across the eval corpus's twenty-six top picks: requiring a figure moved
    // six, and five of them were free. A parent told "it's free" has the whole answer,
    // and a watch row to go back for the fee is Hale promising to answer nothing.
    expect(watchWarranted([pick({ price: 'Free' })])).toBe(false);
    expect(watchWarranted([pick({ price: 'Free drop-in, no registration' })])).toBe(false);
    // ...but "free" is not a WHEN. A session described as free play still has no day.
    expect(watchWarranted([pick({ when: 'Free play', price: '$124 per term' })])).toBe(true);
  });

  it('POSITIVE CONTROL - a partial figure is still a figure', () => {
    // The gate must not become "only a perfect field counts", or every find grows a watch
    // and the sentence that promises one stops meaning anything.
    expect(watchWarranted([pick({ when: 'Sundays', price: '$124' })])).toBe(false);
    expect(watchWarranted([pick({ when: 'Starts Sept 14', price: '$124 per term' })])).toBe(false);
  });
});

/**
 * THE SLOTS THE TEXT CARRIES. On 2026-11-09 the live extract put the registration row
 * third, behind two class rows for the same programme, and the text — which carried the
 * first two — never told the parent the date the pass had opened a page to read.
 */
describe('textSlots', () => {
  const classRow = pick({ registration: 'Availability and pricing only show after login' });
  const scheduleRow = pick({ name: 'Tiny Gym (schedule at a glance)', price: null });
  const registrationRow = pick({
    name: 'Fall registration (covers Tiny Gym)',
    when: null,
    price: null,
    registration: 'Fall registration opened Wednesday July 22 at 8:00am, online',
  });
  const otherClass = pick({ name: 'Kinderfun', registration: null });

  it('carries a later registration date alongside the two best slots', () => {
    const { picks, held } = textSlots([classRow, scheduleRow, otherClass, registrationRow]);
    expect(picks).toEqual([classRow, scheduleRow, registrationRow]);
    expect(held).toEqual([otherClass]);
  });

  it('leaves the cut alone when a slot in the text already states a registration date', () => {
    const dated = pick({ registration: 'Registration opens Aug 11 at 7 a.m.' });
    const { picks, held } = textSlots([dated, scheduleRow, registrationRow]);
    expect(picks).toEqual([dated, scheduleRow]);
    expect(held).toEqual([registrationRow]);
  });

  it('does not count registration prose with no date as a registration fact', () => {
    const { picks, held } = textSlots([classRow, scheduleRow, otherClass]);
    expect(picks).toEqual([classRow, scheduleRow]);
    expect(held).toEqual([otherClass]);
  });
});

/**
 * WHERE A KEPT PROMISE LANDS. The answer to a question asked in a 1:1 iMessage chat goes
 * back into that chat, threaded under the message that carried the promise, which was
 * itself the reply to the ask. It never moves to the household group, which other adults
 * read. A promise with no known 1:1 thread keeps today's routing.
 */
describe('deliverFollowUp: the thread the answer lands in', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const NOW = new Date('2026-08-24T18:00:00.000Z');

  function delivery(transport: FakeTransport): FollowUpDelivery {
    return {
      composer: {
        async compose() {
          return {
            status: 'composed',
            message: 'Tiny Gym runs Sundays 9:30.',
            mentionsWatch: false,
          };
        },
      },
      refuseUnbackedSend: async () => [],
      resolveSendablePhone: async () => '+14165550100',
      transport,
      recordSend: async () => 'msg-out-1',
      audit: async () => {},
      threadMessage: async () => 'conv-1',
      fulfillCommitment: async () => ({ status: 'closed' as const, commitmentIds: ['commit-1'] }),
      recordWatch: async () => ({ status: 'recorded' as const, commitmentId: 'commit-2' }),
    };
  }

  function input(thread: FollowUpRecipient['thread']): FollowUpDeliveryInput {
    return {
      commitmentId: 'commit-1',
      familyId: 'fam-1',
      subjectChildId: null,
      subject: 'indoor swim lessons',
      recipient: { parentUserId: 'parent-1', conversationId: 'conv-1', language: 'en', thread },
      dedupeKey: 'activity_followup:commit-1',
      optOut: 'short',
      picks: [pick()],
      held: [],
      pageEvidence: 'page_has_schedule',
      evidence: noEvidence(),
      heardFacts: null,
      askLanguage: null,
      lane: 'immediate',
    };
  }

  it('a 1:1 iMessage promise is answered in that chat, threaded under the message that carried it', async () => {
    const transport = new FakeTransport();
    const outcome = await deliverFollowUp(
      {} as Database,
      delivery(transport),
      input({ chatId: 'chat-1', messageId: 'pm-1' }),
      NOW,
    );
    expect(outcome.status).toBe('sent');
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]?.replyIn).toEqual({ chatId: 'chat-1', messageId: 'pm-1' });
  });

  it('positive control: no known 1:1 thread carries no thread target, and routes as today', async () => {
    const transport = new FakeTransport();
    await deliverFollowUp({} as Database, delivery(transport), input(null), NOW);
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]).not.toHaveProperty('replyIn');
  });

  // The watch a follow-up mints keeps answering the same ask, so it carries the ask's
  // language on its own row: the look a week later is written in it too, while lit.
  it.each([['zh'], [null]])(
    "the watch it mints carries the language of the parent's ask (%s)",
    async (askLanguage) => {
      const watched: Array<Record<string, unknown>> = [];
      const deps: FollowUpDelivery = {
        ...delivery(new FakeTransport()),
        recordWatch: async (_db, watch) => {
          watched.push(watch);
          return { status: 'recorded' as const, commitmentId: 'commit-2' };
        },
      };
      const outcome = await deliverFollowUp(
        {} as Database,
        deps,
        { ...input(null), picks: [pick({ price: null })], askLanguage },
        NOW,
      );
      expect(outcome).toMatchObject({ status: 'sent', watchRecorded: true });
      expect(watched).toHaveLength(1);
      expect(watched[0]?.askLanguage).toBe(askLanguage);
    },
  );
});
