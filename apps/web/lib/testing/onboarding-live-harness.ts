import { randomUUID } from 'node:crypto';
import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import type { KidItemClassifier } from '~/lib/channel/connect/aha-kids';
import {
  type AhaSnapshot,
  calendarFactsFromItems,
  calendarOverlaps,
  emailFactsFromMessages,
} from '~/lib/channel/connect/aha-read';
import { sendConnectorConnectedText } from '~/lib/channel/connect/connected-notice';
import { routeInboundText } from '~/lib/channel/inbound-route';
import { type ActivityMapGroup, renderActivityMapBody } from '~/lib/channel/intake/activity-map';
import {
  FakeExtractor,
  FakeIdentityAsk,
  FakeIntentReader,
  fakeAckComposer,
  fakeNoOpenQuestions,
  fakeSilentAnswerComposer,
} from '~/lib/channel/intake/fakes';
import type { FriendVoiceComposer } from '~/lib/channel/intake/friend-voice';
import type { IntakeDeps } from '~/lib/channel/intake/machine';
import type { RadarPayload } from '~/lib/channel/intake/radar';
import { FakeTransport, type InboundMessage } from '~/lib/channel/intake/transport';
import { threadProactiveMessage } from '~/lib/channel/thread';
import { FakeRateLimiter } from '~/lib/rate-limit/fake';
import {
  type LiveExpectations,
  type LiveTurn,
  liveViolations,
  p50TurnMs,
} from './onboarding-live-rules';

/**
 * The founder's iMessage walk (VIL-417), replayed against the real intake
 * machine and the real connect receipts. The composer and the kid-item
 * classifier are ports: the live test hands in the real model, the mechanics
 * test a scripted stand-in. The activity search, the mailbox and the calendar
 * are stubs so a run is reproducible and the rule checks have ground truth.
 */

export const LIVE_PHONE = '+14165551234';
export const LIVE_CHAT = '8f392755-6865-4b18-880a-227f9d8b458f';
export const LIVE_FROM = '+15555550100';
/** A Monday. The stub mailbox and calendar sit in the two weeks after it. */
export const LIVE_NOW = new Date('2026-10-05T14:00:00.000Z');

export const LIVE_MAP_GROUPS: readonly ActivityMapGroup[] = [
  {
    category: 'parent_baby',
    lines: [
      'EarlyON Georgetown drop-in (0-6 yrs) - Tuesdays 9:30',
      'Baby and Me storytime at Halton Hills Library (0-24 months) - Thursdays 10:30',
    ],
    titles: ['EarlyON Georgetown drop-in', 'Baby and Me storytime at Halton Hills Library'],
  },
  {
    category: 'swimming',
    lines: [
      'Parent and Tot Swim at Gellert Centre (6-36 months) - Saturdays 10:00',
      'Swim Kids 3 at Gellert Centre (ages 6-8) - Saturdays 11:00',
    ],
    titles: ['Parent and Tot Swim at Gellert Centre', 'Swim Kids 3 at Gellert Centre'],
  },
  {
    category: 'social_growth',
    lines: [
      'Beavers at 1st Georgetown Scouts (ages 5-7) - Wednesdays 18:30',
      'Open gym for families at Mold-Masters SportsPlex (all ages) - Sundays 13:00',
    ],
    titles: [
      'Beavers at 1st Georgetown Scouts',
      'Open gym for families at Mold-Masters SportsPlex',
    ],
  },
];
export const LIVE_MAP_LINES = LIVE_MAP_GROUPS.flatMap((group) => group.lines);

export const LIVE_KID_MAIL = [
  'Picture Day at Park Public School Thu Oct 8',
  'Seb 15-month checkup - Georgetown Pediatrics',
] as const;
export const LIVE_PARENT_MAIL = [
  'Rotman School alumni dinner - RSVP',
  'Coffee next week? - Sebastian',
  'Baby shower for Jen',
  'Library hold ready: Atomic Habits',
] as const;
export const LIVE_KID_CALENDAR = ['Mia swim', 'Mia birthday party'] as const;
export const LIVE_PARENT_CALENDAR = [
  '1:1 with Mia Chen (Product)',
  'Music festival with friends',
  'Camp Ventures offsite',
] as const;

export const LIVE_SCRIPT = [
  'hi',
  'L7G 4S8',
  'wait who is this? is this free?',
  'Sebastian and Mia. Seb is 1, Mia just turned 6',
  'Barton',
  'hmm do you read all my emails? there is a lot of work stuff in there',
  'ok fine',
  '[gmail connected]',
  '[calendar connected]',
  "Put Mia's swim on weekly please. And the library drop-in for Seb, just this Thursday",
  'sounds good',
  'maybe, her mom is on iMessage too',
  'thanks!',
] as const;

export const LIVE_EXPECTATIONS: LiveExpectations = {
  mapLines: LIVE_MAP_LINES,
  parentName: 'Barton',
  kidItems: [...LIVE_KID_MAIL, ...LIVE_KID_CALENDAR],
  parentItems: [...LIVE_PARENT_MAIL, ...LIVE_PARENT_CALENDAR],
  scheduledMust: [/swim kids/i, /storytime|library/i],
  scheduledMustNot: [/parent and tot/i, /beavers/i, /open gym/i, /earlyon/i],
};

function mail(subject: string, from: string, at: string, snippet: string) {
  return {
    internalDate: String(new Date(at).getTime()),
    snippet,
    payload: {
      headers: [
        { name: 'Subject', value: subject },
        { name: 'From', value: from },
      ],
    },
  };
}

/** The stub mailbox: two kid items among four of the parent's own. */
export function liveGmailStub(): AhaSnapshot {
  const email = emailFactsFromMessages([
    mail(
      LIVE_KID_MAIL[0],
      'Park Public School <office@parkps.example>',
      '2026-10-02T13:00:00Z',
      'Picture day is Thursday October 8. Order forms went home in backpacks.',
    ),
    mail(
      LIVE_PARENT_MAIL[0],
      'Rotman Alumni <alumni@rotman.example>',
      '2026-10-03T15:00:00Z',
      'Please RSVP for the dinner on October 22.',
    ),
    mail(
      LIVE_PARENT_MAIL[1],
      'Sebastian Rourke <seb@example.com>',
      '2026-10-03T18:00:00Z',
      'Are you around for a coffee next week?',
    ),
    mail(
      LIVE_KID_MAIL[1],
      'Georgetown Pediatrics <desk@gtpeds.example>',
      '2026-10-04T12:00:00Z',
      'Reminder: the 15-month checkup is booked for October 14 at 9:40.',
    ),
    mail(
      LIVE_PARENT_MAIL[2],
      'Priya <priya@example.com>',
      '2026-10-04T16:00:00Z',
      'Baby shower for Jen, Sunday the 18th at 2.',
    ),
    mail(
      LIVE_PARENT_MAIL[3],
      'Halton Hills Public Library <holds@hhpl.example>',
      '2026-10-05T09:00:00Z',
      'Your hold is ready for pickup.',
    ),
  ]);
  return { provider: 'gmail', read: 'ok', calendar: [], email, overlaps: [] };
}

function event(summary: string, start: string, end: string, location?: string) {
  return { summary, location, start: { dateTime: start }, end: { dateTime: end } };
}

/** The stub calendar: Mia's swim overlaps her party; the rest is the parent's. */
export function liveCalendarStub(now: Date = LIVE_NOW): AhaSnapshot {
  const calendar = calendarFactsFromItems(
    [
      event(LIVE_PARENT_CALENDAR[0], '2026-10-06T14:00:00Z', '2026-10-06T14:30:00Z'),
      event(LIVE_PARENT_CALENDAR[2], '2026-10-09T13:00:00Z', '2026-10-09T21:00:00Z'),
      event(LIVE_KID_CALENDAR[0], '2026-10-17T14:00:00Z', '2026-10-17T14:45:00Z', 'Gellert Centre'),
      event(LIVE_KID_CALENDAR[1], '2026-10-17T14:15:00Z', '2026-10-17T16:00:00Z', "Ella's house"),
      event(LIVE_PARENT_CALENDAR[1], '2026-10-24T20:00:00Z', '2026-10-25T02:00:00Z'),
    ],
    now,
  );
  return {
    provider: 'gcal',
    read: 'ok',
    calendar,
    email: [],
    overlaps: calendarOverlaps(calendar),
  };
}

/** The stub activity search: the map above, already grouped. */
export function liveRadarPayload(): RadarPayload {
  const groups = LIVE_MAP_GROUPS.map((group) => ({ ...group }));
  return {
    message: renderActivityMapBody({ groups }),
    itemCount: LIVE_MAP_LINES.length,
    followUpNeeded: false,
    checkpointTold: null,
    weekendPickOffered: false,
    findWon: true,
    firstFindPromised: false,
    actionMove: null,
    actionHeld: 'no_move',
    voiceFallback: null,
    groups,
  };
}

export interface LiveReplayPorts {
  friendVoice: FriendVoiceComposer;
  kidItems: KidItemClassifier;
  /** Where each outbound bubble is printed verbatim. Default: nowhere. */
  print?: (line: string) => void;
  now?: Date;
}

export interface LiveReplayStored {
  parentName: string | null;
  kidNames: string[];
  scheduledTitles: string[];
}

export interface LiveReplayReport {
  turns: LiveTurn[];
  stored: LiveReplayStored;
  /** p50 of the measured turn latencies, in ms. */
  p50Ms: number | null;
  /** The rules broken, as short sentences. Empty is a clean run. */
  violations: string[];
}

const QUIET = { info: () => undefined, warn: () => undefined, error: () => undefined };

/**
 * Walks {@link LIVE_SCRIPT} through `routeInboundText` on iMessage, lands the
 * two connector receipts through `sendConnectorConnectedText`, then reads back
 * what was stored and runs the rule checks.
 */
export async function runOnboardingReplay(
  database: Database,
  ports: LiveReplayPorts,
): Promise<LiveReplayReport> {
  const now = ports.now ?? LIVE_NOW;
  const print = ports.print ?? (() => undefined);
  const transport = new FakeTransport();
  const deps: IntakeDeps = {
    transport,
    threadMessage: threadProactiveMessage,
    openQuestions: fakeNoOpenQuestions,
    extractor: new FakeExtractor([{ children: [], postalCode: null }]),
    intentReader: new FakeIntentReader([
      { intent: 'assent', verbatim: 'yes', interpretation: 'plain yes' },
    ]),
    radar: { compose: async () => liveRadarPayload() },
    ackComposer: fakeAckComposer,
    answerComposer: fakeSilentAnswerComposer,
    identityAsk: new FakeIdentityAsk(),
    limiter: new FakeRateLimiter(() => now.getTime()),
    seedCivic: async () => 0,
    resolveCenter: async () => ({ lat: 43.6471, lng: -79.9303 }),
    discoveryTrigger: () => {},
    friendVoice: ports.friendVoice,
    now,
  };
  const turns: LiveTurn[] = [];
  let sequence = 0;

  const show = (label: string, bubbles: string[]) => {
    print(`\n${label}`);
    for (const bubble of bubbles) print(`  < ${bubble.replace(/\n/g, '\n    ')}`);
    if (bubbles.length === 0) print('  < (nothing sent)');
  };

  const say = async (body: string) => {
    sequence += 1;
    const from = transport.bodies().length;
    const inbound: InboundMessage = {
      from: LIVE_PHONE,
      body,
      providerId: `live-${sequence}`,
      receivedAt: now,
      transport: 'imessage',
      chatId: LIVE_CHAT,
    };
    const started = Date.now();
    const outcome = await routeInboundText(
      {
        database,
        log: QUIET,
        countOutcome: async () => undefined,
        intake: () => deps,
        enqueue: async () => undefined,
        now: () => now,
      },
      inbound,
      0,
    );
    const bubbles = transport.bodies().slice(from);
    turns.push({ inbound: body, bubbles, ms: Date.now() - started, outcome });
    show(`> ${body}`, bubbles);
    if (outcome === 'handed_off') print("  (handed off to the coach: that reply is the worker's)");
  };

  const family = async () => {
    const [row] = await database
      .select({
        familyId: schema.smsIntakeSessions.familyId,
        userId: schema.smsIntakeSessions.userId,
      })
      .from(schema.smsIntakeSessions);
    if (!row?.familyId || !row.userId) throw new Error('no family after provisioning');
    return { familyId: row.familyId, parentUserId: row.userId };
  };

  const connected = async (provider: 'gmail' | 'gcal', aha: AhaSnapshot) => {
    const label = provider === 'gmail' ? '[gmail connected]' : '[calendar connected]';
    const from = transport.bodies().length;
    const { familyId, parentUserId } = await family();
    const started = Date.now();
    const outcome = await sendConnectorConnectedText(
      database,
      { familyId, parentUserId, provider, connectId: randomUUID(), now, aha },
      {
        transport,
        imessage: async (input) => transport.send({ to: input.chatId, body: input.body }),
        threadMessage: threadProactiveMessage,
        friendVoice: ports.friendVoice,
        kidItems: ports.kidItems,
      },
    );
    const bubbles = transport.bodies().slice(from);
    turns.push({ inbound: label, bubbles, ms: Date.now() - started });
    const reason = 'reason' in outcome ? ` (${outcome.reason})` : '';
    show(`${label} -> ${outcome.status}${reason}`, bubbles);
  };

  for (const line of LIVE_SCRIPT) {
    if (line === '[gmail connected]') await connected('gmail', liveGmailStub());
    else if (line === '[calendar connected]') await connected('gcal', liveCalendarStub(now));
    else await say(line);
  }

  const { familyId, parentUserId } = await family();
  const [parent] = await database
    .select({ name: schema.users.name })
    .from(schema.users)
    .where(eq(schema.users.id, parentUserId));
  const kids = await database
    .select({ name: schema.children.name })
    .from(schema.children)
    .where(eq(schema.children.familyId, familyId));
  const events = await database
    .select({ title: schema.familyEvents.title })
    .from(schema.familyEvents)
    .where(eq(schema.familyEvents.familyId, familyId));

  const stored: LiveReplayStored = {
    parentName: parent?.name ?? null,
    kidNames: kids.flatMap((kid) => (kid.name ? [kid.name] : [])),
    scheduledTitles: events.map((row) => row.title),
  };
  const violations = liveViolations({ turns, ...stored }, LIVE_EXPECTATIONS);
  const p50Ms = p50TurnMs(turns);

  print('\n--- stored ---');
  print(`parent name: ${JSON.stringify(stored.parentName)}`);
  print(`kids: ${stored.kidNames.join(', ')}`);
  print(
    `reminders: ${[...new Set(stored.scheduledTitles)].join(' | ') || '(none)'} (${events.length} events)`,
  );
  print(`p50 turn latency: ${p50Ms == null ? 'n/a' : `${p50Ms} ms`}`);
  print('\n--- rule checks ---');
  if (violations.length === 0) print('all clear');
  for (const line of violations) print(`x ${line}`);

  return { turns, stored, p50Ms, violations };
}
