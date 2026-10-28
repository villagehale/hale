import type { ReplyLanguage } from '~/lib/channel/language';
import { followupBlockedByQuietHours, runGroupPlanFollowups } from './followups';
import { memberKeyFromHandle } from './member-key';
import { createMemoryGroupPlanRsvpStore, createMemoryWorld } from './memory-store';
import type { GroupPlanRsvpReader, GroupPlanRsvpReading } from './reading';
import { takeGroupPlanRsvpTurn } from './turn';
import type { GroupPlanRsvpComposer } from './voice';
import { fakeGroupPlanRsvpComposer } from './voice-fake';

/**
 * Preview proof for VIL-442. Fake families, no real SMS, no real people.
 * Several people talk in one group. Hale answers only at settle points.
 *
 * The runner uses the real turn and follow-up code. A composer is injected:
 * production Preview with a key uses the model; this environment without keys
 * uses the fact-repeating stand-in so the conversation still exists, and the
 * skip is named when the model is asked and missing.
 */

export interface PreviewPerson {
  name: string;
  handle: string;
  haleCustomer: boolean;
}

export interface PreviewLine {
  from: string;
  text: string;
  tapback?: 'like' | 'love' | 'dislike' | 'laugh' | null;
  reading: GroupPlanRsvpReading;
}

export interface PreviewTranscriptLine {
  speaker: string;
  text: string;
  kind: 'person' | 'hale' | 'hale_skipped' | 'note';
}

export interface PreviewConversationResult {
  id: string;
  title: string;
  instinct: string[];
  people: PreviewPerson[];
  transcript: PreviewTranscriptLine[];
  tally: {
    yesCount: number;
    yesHeads: number;
    yesNames: string[];
    noCount: number;
    waitingNames: string[];
    toGo: number;
  } | null;
  beforeAfter: { before: string; after: string };
}

const KEY = Buffer.alloc(32, 7).toString('base64');

function ensureKey(): void {
  process.env.APP_ENCRYPTION_KEY ??= KEY;
}

function readerFor(line: PreviewLine): GroupPlanRsvpReader {
  return { read: async () => line.reading };
}

async function play(input: {
  id: string;
  title: string;
  instinct: string[];
  chatId: string;
  language: ReplyLanguage;
  people: PreviewPerson[];
  lines: PreviewLine[];
  followUpAt?: Date;
  quietFollowUpAt?: Date;
  composer: GroupPlanRsvpComposer;
  beforeAfter: { before: string; after: string };
}): Promise<PreviewConversationResult> {
  ensureKey();
  const world = createMemoryWorld();
  world.families.set(input.chatId, { familyId: `fam-${input.id}`, timeZone: 'America/Toronto' });
  world.seats.set(
    input.chatId,
    input.people.map((person) => ({
      memberKey: memberKeyFromHandle(person.handle) as string,
      displayName: person.name,
      userId: person.haleCustomer ? `user-${person.name}` : null,
      haleCustomer: person.haleCustomer,
    })),
  );
  const store = createMemoryGroupPlanRsvpStore(world);
  const transcript: PreviewTranscriptLine[] = [];
  let now = new Date('2026-10-28T16:00:00.000Z');
  let lastTally: PreviewConversationResult['tally'] = null;

  for (const line of input.lines) {
    const person = input.people.find((p) => p.name === line.from);
    if (!person) throw new Error(`preview: unknown person ${line.from}`);
    transcript.push({
      speaker: line.from,
      text: line.tapback ? `(${line.tapback} tapback)` : line.text,
      kind: 'person',
    });
    const texts: string[] = [];
    const outcome = await takeGroupPlanRsvpTurn(
      {
        chatId: input.chatId,
        senderHandle: person.handle,
        senderName: person.name,
        text: line.text,
        tapback: line.tapback ?? null,
        language: input.language,
        now,
      },
      {
        store,
        reader: readerFor(line),
        composer: input.composer,
        send: async ({ text }) => {
          texts.push(text);
          return { providerMessageId: `preview-${texts.length}` };
        },
        enabled: () => true,
      },
    );
    now = new Date(now.getTime() + 60_000);
    if (outcome.handled && outcome.tally) {
      lastTally = {
        yesCount: outcome.tally.yesCount,
        yesHeads: outcome.tally.yesHeads,
        yesNames: [...outcome.tally.yesNames],
        noCount: outcome.tally.noCount,
        waitingNames: [...outcome.tally.waitingNames],
        toGo: outcome.tally.toGo,
      };
    }
    if (outcome.handled && outcome.outcome === 'group_plan_spoken' && texts[0]) {
      transcript.push({ speaker: 'Hale', text: texts[0], kind: 'hale' });
    } else if (outcome.handled && outcome.outcome === 'group_plan_line_unsent') {
      const skipped =
        outcome.notice && typeof outcome.notice === 'object' ? outcome.notice.skipped : 'not_sent';
      transcript.push({
        speaker: 'Hale',
        text: `skipped: ${skipped}`,
        kind: 'hale_skipped',
      });
    } else if (outcome.handled && outcome.outcome === 'group_plan_chatter') {
      transcript.push({
        speaker: 'note',
        text: 'Hale stayed quiet (banter).',
        kind: 'note',
      });
    } else if (outcome.handled && outcome.outcome === 'group_plan_recorded') {
      transcript.push({
        speaker: 'note',
        text: `Recorded. ${lastTally?.yesCount ?? 0} yes, ${lastTally?.toGo ?? 0} to go.`,
        kind: 'note',
      });
    }
  }

  if (input.quietFollowUpAt) {
    const quiet = followupBlockedByQuietHours(input.quietFollowUpAt, 'America/Toronto');
    transcript.push({
      speaker: 'note',
      text: quiet
        ? 'Follow-up tick during quiet hours: nothing sent.'
        : 'Follow-up tick was not in quiet hours.',
      kind: 'note',
    });
    await runGroupPlanFollowups(
      {
        store,
        composer: input.composer,
        send: async () => ({ providerMessageId: 'quiet' }),
        enabled: () => true,
      },
      input.quietFollowUpAt,
    );
  }

  if (input.followUpAt) {
    const texts: string[] = [];
    await runGroupPlanFollowups(
      {
        store,
        composer: input.composer,
        send: async ({ text }) => {
          texts.push(text);
          return { providerMessageId: `follow-${texts.length}` };
        },
        enabled: () => true,
      },
      input.followUpAt,
    );
    if (texts[0]) transcript.push({ speaker: 'Hale', text: texts[0], kind: 'hale' });
    const again: string[] = [];
    await runGroupPlanFollowups(
      {
        store,
        composer: input.composer,
        send: async ({ text }) => {
          again.push(text);
          return { providerMessageId: 'dup' };
        },
        enabled: () => true,
      },
      input.followUpAt,
    );
    if (again.length === 0) {
      transcript.push({
        speaker: 'note',
        text: 'Second follow-up tick: deduped, nothing sent.',
        kind: 'note',
      });
    }
  }

  return {
    id: input.id,
    title: input.title,
    instinct: input.instinct,
    people: input.people,
    transcript,
    tally: lastTally,
    beforeAfter: input.beforeAfter,
  };
}

function startPicnic(): GroupPlanRsvpReading {
  return {
    intent: 'start_tracking',
    planTitle: 'Saturday picnic',
    startsAt: '2026-11-01T16:00:00.000Z',
    location: 'High Park',
    deadline: '2026-10-31T20:00:00.000Z',
    response: null,
    headcount: 1,
    householdLabel: null,
    coversNames: [],
    confidence: 'high',
  };
}

export async function runPreviewGroupPlanConversations(
  options: {
    composer?: GroupPlanRsvpComposer;
  } = {},
): Promise<PreviewConversationResult[]> {
  const composer = options.composer ?? fakeGroupPlanRsvpComposer();

  const picnic = await play({
    id: 'picnic-edits',
    title: 'Saturday picnic — count stays right after an edit',
    instinct: [
      '1 zero-setup, including a member who never signed up',
      '2 quiet during banter; speaks at settle points',
      '3 tapback and plain language as votes; no poll or RSVP button',
      '6 AI-written / named skip; no fixed copy',
    ],
    chatId: 'preview-picnic',
    language: 'en',
    people: [
      { name: 'Priya', handle: '+14165550101', haleCustomer: true },
      { name: 'Sam', handle: '+14165550102', haleCustomer: false },
      { name: 'Maya', handle: '+14165550103', haleCustomer: false },
    ],
    composer,
    beforeAfter: {
      before:
        'Birthday-only party tally in lib/party/*: keyword matchers, frozen host copy, a public RSVP page with buttons. A picnic or museum Saturday had no count.',
      after:
        'Any plan in the group chat. Priya asks Hale to keep count. Sam (not a Hale user) thumbs-up. Maya jokes; Hale stays quiet. Maya then changes her household answer; the live count updates in place.',
    },
    lines: [
      {
        from: 'Priya',
        text: 'Hale can you keep track of who is coming to the picnic Saturday?',
        reading: startPicnic(),
      },
      {
        from: 'Sam',
        text: '',
        tapback: 'like',
        reading: {
          intent: 'rsvp',
          planTitle: null,
          startsAt: null,
          location: null,
          deadline: null,
          response: 'yes',
          headcount: 1,
          householdLabel: null,
          coversNames: [],
          confidence: 'high',
        },
      },
      {
        from: 'Maya',
        text: 'lol remember last time with the wasps',
        reading: {
          intent: 'chatter',
          planTitle: null,
          startsAt: null,
          location: null,
          deadline: null,
          response: null,
          headcount: 1,
          householdLabel: null,
          coversNames: [],
          confidence: 'high',
        },
      },
      {
        from: 'Maya',
        text: 'actually we cannot make it',
        reading: {
          intent: 'edit',
          planTitle: null,
          startsAt: null,
          location: null,
          deadline: null,
          response: 'no',
          headcount: 1,
          householdLabel: null,
          coversNames: [],
          confidence: 'high',
        },
      },
      {
        from: 'Priya',
        text: 'where do we stand',
        reading: {
          intent: 'ask_tally',
          planTitle: null,
          startsAt: null,
          location: null,
          deadline: null,
          response: null,
          headcount: 1,
          householdLabel: null,
          coversNames: [],
          confidence: 'high',
        },
      },
    ],
  });

  const museum = await play({
    id: 'museum-family',
    title: 'Museum Saturday — one parent answers for the whole household',
    instinct: [
      '3 plain language as a household yes',
      '4 names people; one ask per turn',
      '5 actually records the household RSVP',
      '7 only what was said in the chat',
    ],
    chatId: 'preview-museum',
    language: 'en',
    people: [
      { name: 'Priya', handle: '+14165550111', haleCustomer: true },
      { name: 'Maya', handle: '+14165550113', haleCustomer: false },
      { name: 'Wei', handle: '+14165550114', haleCustomer: false },
      { name: 'Sam', handle: '+14165550112', haleCustomer: false },
    ],
    composer,
    beforeAfter: {
      before:
        'A party RSVP form counted one guest name. There was no way to answer for a household inside the group chat.',
      after:
        'Maya says the Chens are in, three people. Wei is no longer waiting. Sam is still to go. Hale speaks because a household answer changed the count.',
    },
    lines: [
      {
        from: 'Priya',
        text: 'keep a count for the ROM Saturday?',
        reading: {
          ...startPicnic(),
          planTitle: 'ROM Saturday',
        },
      },
      {
        from: 'Maya',
        text: 'the Chens are in, all three of us',
        reading: {
          intent: 'rsvp',
          planTitle: null,
          startsAt: null,
          location: null,
          deadline: null,
          response: 'yes',
          headcount: 3,
          householdLabel: 'the Chens',
          coversNames: ['Wei'],
          confidence: 'high',
        },
      },
    ],
  });

  const soccer = await play({
    id: 'soccer-followups',
    title: 'Soccer Saturday — follow-ups are deduped and quiet hours hold',
    instinct: [
      '4 one ask to the people still waiting',
      '5 the follow-up actually sends, then a second tick does not',
      '6 no fixed reminder copy',
      '7 no invented availability',
    ],
    chatId: 'preview-soccer',
    language: 'en',
    people: [
      { name: 'Asha', handle: '+14165550121', haleCustomer: true },
      { name: 'Ben', handle: '+14165550122', haleCustomer: false },
    ],
    composer,
    followUpAt: new Date('2026-10-31T18:00:00.000Z'),
    quietFollowUpAt: new Date('2026-10-31T03:00:00.000Z'),
    beforeAfter: {
      before:
        'Party guest reminders were a frozen SMS to opted-in strangers, keyed off a birthday invite page.',
      after:
        'Any plan. One follow-up wave after the deadline, in the covering family timezone, skipped in quiet hours, claimed so a second tick cannot send again.',
    },
    lines: [
      {
        from: 'Asha',
        text: 'Hale, track who is coming to soccer Saturday',
        reading: {
          ...startPicnic(),
          planTitle: 'soccer Saturday',
          deadline: '2026-10-30T20:00:00.000Z',
        },
      },
      {
        from: 'Asha',
        text: 'we will be there',
        reading: {
          intent: 'rsvp',
          planTitle: null,
          startsAt: null,
          location: null,
          deadline: null,
          response: 'yes',
          headcount: 2,
          householdLabel: null,
          coversNames: [],
          confidence: 'high',
        },
      },
    ],
  });

  return [picnic, museum, soccer];
}
