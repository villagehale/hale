import {
  type CarpoolPlanState,
  type CarpoolReading,
  type CarpoolSender,
  applyCarpoolReading,
  markAsked,
  markReminder,
} from './carpool-apply';
import { decideCarpoolReminder, decideCarpoolTurn, localMinutesIn } from './carpool-cadence';
import { readingFromTapback } from './carpool-reading';
import type { CarpoolVoiceInput } from './carpool-voice';

/**
 * VIL-445 Preview proof — several people from fake families, no real SMS.
 *
 * The runner never opens a network door. It applies the same cadence and
 * reading fold as production. The composer is injected so a Preview capture
 * can still show a conversation when Anthropic is unset.
 */

export type PreviewSpeaker = 'Hale' | 'Maya Chen' | 'Luis Rivera' | 'Priya Shah';

export interface PreviewLine {
  from: PreviewSpeaker;
  text: string;
  at: string;
}

export interface PreviewConversation {
  id: string;
  title: string;
  families: string[];
  before: PreviewLine[];
  after: PreviewLine[];
  notes: string[];
}

const TZ = 'America/Toronto';
const SATURDAY = '2026-10-10T12:00:00.000Z';
const FRIDAY_EVE = new Date('2026-10-09T22:00:00.000Z');
const FRIDAY_QUIET = new Date('2026-10-10T01:30:00.000Z');

const MAYA: CarpoolSender = { userId: 'maya', name: 'Maya', haleCustomer: true, timezone: TZ };
const LUIS: CarpoolSender = { userId: 'luis', name: 'Luis', haleCustomer: true, timezone: TZ };
const PRIYA: CarpoolSender = { userId: null, name: 'Priya', haleCustomer: false, timezone: TZ };

const PEOPLE: Record<string, { speaker: PreviewSpeaker; sender: CarpoolSender }> = {
  Maya: { speaker: 'Maya Chen', sender: MAYA },
  Luis: { speaker: 'Luis Rivera', sender: LUIS },
  Priya: { speaker: 'Priya Shah', sender: PRIYA },
};

type ScriptTurn =
  | { who: keyof typeof PEOPLE; text: string; reading: CarpoolReading; at?: Date }
  | { who: keyof typeof PEOPLE; tapback: string; at?: Date }
  | { cron: 'evening' | 'quiet'; at: Date };

function reading(overrides: Partial<CarpoolReading>): CarpoolReading {
  return {
    intent: 'chatter',
    driverName: null,
    eventLabel: 'soccer',
    pickupAtIso: SATURDAY,
    pickupPlace: 'the rec',
    kids: 'Noah and Lea',
    confidence: 'high',
    ...overrides,
  };
}

function play(script: ScriptTurn[], enabled: boolean): { lines: PreviewLine[]; notes: string[] } {
  const lines: PreviewLine[] = [];
  const notes: string[] = [];
  let plan: CarpoolPlanState | null = null;
  const lineFor = (input: CarpoolVoiceInput) => {
    const facts = [
      input.facts.driver,
      input.facts.kids,
      input.facts.pickupTime,
      input.facts.pickupPlace,
      input.facts.event,
    ]
      .filter((value): value is string => Boolean(value))
      .join(' ');
    return input.kind === 'ask_driver' ? `${input.kind} ${facts}?` : `${input.kind} ${facts}`;
  };
  const push = (from: PreviewSpeaker, text: string, at: Date) => {
    lines.push({ from, text, at: at.toISOString() });
  };

  const speakAsk = (at: Date) => {
    const decision = decideCarpoolTurn({
      intent: 'plan_needs_driver',
      confidence: 'high',
      plan,
      addressed: false,
    });
    if (decision.speak !== 'ask_driver' || !plan) return;
    plan = markAsked(plan, at);
    push(
      'Hale',
      lineFor({
        kind: 'ask_driver',
        facts: {
          driver: null,
          kids: plan.kids,
          pickupTime: 'Sat 8:00 a.m.',
          pickupPlace: plan.pickupPlace,
          event: plan.eventLabel,
          language: 'en',
        },
      }),
      at,
    );
  };

  const remind = (at: Date, quiet: boolean) => {
    if (!plan) {
      notes.push('no plan');
      return;
    }
    const decision = decideCarpoolReminder({
      plan,
      now: at,
      localMinutes: localMinutesIn(at, TZ),
      quiet,
      quietStartMin: 21 * 60,
      timeZone: TZ,
    });
    notes.push(
      `reminder:${decision.action}${decision.action === 'skip' || decision.action === 'hold' ? `:${'reason' in decision ? decision.reason : ''}` : ''}`,
    );
    if (decision.action !== 'fire') return;
    const facts = {
      driver: plan.driverName,
      kids: plan.kids,
      pickupTime: 'Sat 8:00 a.m.',
      pickupPlace: plan.pickupPlace,
      event: plan.eventLabel,
      language: 'en',
    };
    push('Hale', lineFor({ kind: 'night_before_group', facts }), at);
    if (plan.driverHaleCustomer) {
      push('Hale', lineFor({ kind: 'night_before_driver', facts }), at);
    } else {
      notes.push('driver_not_customer: group only');
    }
    plan = markReminder(plan, 'sent');
  };

  for (const turn of script) {
    if ('cron' in turn) {
      if (enabled) remind(turn.at, turn.cron === 'quiet');
      else notes.push('before: cron did not run');
      continue;
    }
    const person = PEOPLE[turn.who];
    const at = turn.at ?? new Date('2026-10-08T16:00:00.000Z');
    if ('tapback' in turn) {
      push(person.speaker, `(tapback ${turn.tapback} on Hale's ask)`, at);
      if (!enabled) continue;
      const tap = readingFromTapback({
        reactionType: turn.tapback,
        reactorName: person.sender.name,
        onAsk: Boolean(plan?.askedForDriverAt),
      });
      if (tap) plan = applyCarpoolReading(plan, tap, person.sender, at);
      continue;
    }
    push(person.speaker, turn.text, at);
    if (!enabled) continue;
    plan = applyCarpoolReading(plan, turn.reading, person.sender, at);
    if (turn.reading.intent === 'plan_needs_driver') speakAsk(at);
  }

  return { lines, notes };
}

const NO_DRIVER: ScriptTurn[] = [
  {
    who: 'Maya',
    text: 'Soccer Saturday 8 at the rec — Noah and Lea. Who can drive?',
    reading: reading({ intent: 'plan_needs_driver' }),
  },
  {
    who: 'Luis',
    text: 'I can bring snacks but not the car',
    reading: reading({ intent: 'plan_needs_driver' }),
  },
];

const SWAP: ScriptTurn[] = [
  {
    who: 'Maya',
    text: 'I can take both kids Saturday soccer, 8 at the rec',
    reading: reading({ intent: 'driver_claim', driverName: 'Maya' }),
  },
  {
    who: 'Priya',
    text: 'actually I will drive, Maya you did last week',
    reading: reading({ intent: 'driver_swap', driverName: 'Priya' }),
  },
  { cron: 'evening', at: FRIDAY_EVE },
];

const QUIET: ScriptTurn[] = [
  {
    who: 'Luis',
    text: "I'll drive Saturday",
    reading: reading({ intent: 'driver_claim', driverName: 'Luis' }),
  },
  { cron: 'quiet', at: FRIDAY_QUIET },
];

const CANCEL: ScriptTurn[] = [
  {
    who: 'Maya',
    text: "I'll drive Saturday soccer",
    reading: reading({ intent: 'driver_claim', driverName: 'Maya' }),
  },
  {
    who: 'Luis',
    text: 'game is cancelled, stay home',
    reading: reading({ intent: 'cancel' }),
  },
  { cron: 'evening', at: FRIDAY_EVE },
];

const TAPBACK: ScriptTurn[] = [
  {
    who: 'Maya',
    text: 'Need a driver for Saturday soccer 8 at the rec',
    reading: reading({ intent: 'plan_needs_driver' }),
  },
  { who: 'Priya', tapback: 'love' },
];

function conversation(
  id: string,
  title: string,
  script: ScriptTurn[],
  extraAfter: string[] = [],
): PreviewConversation {
  const before = play(script, false);
  const after = play(script, true);
  return {
    id,
    title,
    families: ['Chen (Maya, Noah)', 'Rivera (Luis, Lea)', 'Shah (Priya, not a Hale customer)'],
    before: before.lines,
    after: after.lines,
    notes: [...after.notes, ...extraAfter],
  };
}

export function runCarpoolPreviewConversations(): PreviewConversation[] {
  return [
    conversation('no-driver-ask-once', 'No driver yet — Hale asks once', NO_DRIVER, [
      'second mention did not earn a second ask',
    ]),
    conversation('driver-swap', 'Driver swaps mid-thread — reminder follows Priya', SWAP, [
      'Priya is not a Hale customer, so the reminder stays in the group',
    ]),
    conversation('quiet-hours', 'Night-before respects quiet hours', QUIET),
    conversation('cancelled', 'Nothing is sent after the plan is cancelled', CANCEL),
    conversation('tapback-yes', 'A heart on the ask is Priya taking the drive', TAPBACK),
  ];
}

export function previewConversationFacts(conversations: PreviewConversation[]): {
  haleSpoke: number;
  families: number;
} {
  const haleSpoke = conversations.reduce(
    (count, conversation) =>
      count + conversation.after.filter((line) => line.from === 'Hale').length,
    0,
  );
  return { haleSpoke, families: 3 };
}

export type { CarpoolVoiceInput };
