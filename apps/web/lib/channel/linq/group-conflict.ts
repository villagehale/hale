import { createHash } from 'node:crypto';
import { type ReplyLanguage, localeFor } from '~/lib/channel/language';
import type { PollOptionWrite } from './poll';

/**
 * VIL-444 (T24) — one group alert when two things a family has on collide.
 *
 * Code reads times, never words. A kid plan rests on whoever has it: the taker the family
 * stored (a duty owner, a decided who-takes), else the one calendar it is on. A clash is
 * that person busy then, or two plans at once that the people free on the calendars Hale
 * can see cannot split between them. Two parents covering is not a clash. Nobody is called
 * free from a calendar Hale cannot see; the alert may ask them instead. A private block
 * arrives here as an owner and a time, and leaves as "busy". A plan settled in the group
 * (a claim the model read, group-pickup-claim.ts, or a vote on a who-takes poll) is never
 * in an alert, and the person it names is not free for anything else then.
 *
 * The model writes the alert from {@link groupConflictLineInput}. With LINQ_POLLS on, the
 * alert may carry the who-takes poll ({@link clashPollOffer}): the names are the people in
 * the chat as stored, the last option is the model's, and the model decides whether the
 * poll fits the ask at all. Nothing here is copy.
 */

const LOOKAHEAD_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Longer than this, a kid item is a container (a school day, daycare, a camp day). Only
 * its drop-off and pickup tie up an adult, and those are items of their own when a family
 * tracks them. Counting the whole span would make every appointment inside it a clash.
 */
const CONTAINER_MS = 3 * 60 * 60 * 1000;

export interface ClashPerson {
  /** A user id, or `named:<label>` for a stored taker with no account. */
  id: string;
  /** The first name the group knows. Empty: never suggested, asked, or named. */
  name: string;
  /** Hale reads this person's free/busy. Only then may the alert call them free. */
  calendar: boolean;
}

export interface ClashPlan {
  /** One plan at one time, stable across sweeps. */
  key: string;
  title: string;
  start: Date;
  end: Date;
  /** People whose connected calendars carry it. Empty for a plan Hale holds. */
  holders: readonly string[];
  /** The taker the family stored. Null falls back to the one calendar it is on. */
  takerId: string | null;
  /** Settled in the group: the taker took it, or a poll vote named them. It outranks any calendar. */
  claimed: boolean;
  /** Calendar rows the alert names, stamped announced once it lands. */
  rows: readonly { integrationId: string; eventId: string }[];
}

/** Time a person has taken. Nothing else about it reaches this file. */
export interface ClashBusy {
  key: string;
  personId: string;
  start: Date;
  end: Date;
  /** Hale's own record of a stored taker: it counts without that person's calendar. */
  known: boolean;
}

export interface GroupClashInput {
  plans: readonly ClashPlan[];
  busy: readonly ClashBusy[];
  people: readonly ClashPerson[];
  now: Date;
}

export interface GroupClash {
  dedupeKey: string;
  first: ClashPlan;
  /** The plan it collides with, or the busy time of the person it rests on. */
  second: { plan: ClashPlan } | { busy: ClashBusy };
  /** Plan key to the person it rests on now. */
  restsOn: Readonly<Record<string, string | null>>;
  /** Free on a calendar Hale can see, and the plan they could take. */
  suggested: { personId: string; planKey: string } | null;
  alsoFree: readonly string[];
  /** Busy then, on a calendar Hale can see or a plan Hale holds for them. */
  busy: readonly string[];
  /** Calendars Hale cannot see: they may be asked, never called free. */
  couldAsk: readonly string[];
}

type Span = { start: Date; end: Date };

function overlaps(a: Span, b: Span): boolean {
  return a.start.getTime() < b.end.getTime() && b.start.getTime() < a.end.getTime();
}

/** Ties up an adult from now until it ends: not a container, and not over. */
function takesTime(plan: ClashPlan, now: Date): boolean {
  const length = plan.end.getTime() - plan.start.getTime();
  return length > 0 && length <= CONTAINER_MS && plan.end.getTime() > now.getTime();
}

/** Ahead in the next two weeks and ties up an adult: a plan someone has to take. */
export function watchedPlan(plan: ClashPlan, now: Date): boolean {
  const start = plan.start.getTime();
  return takesTime(plan, now) && start > now.getTime() && start <= now.getTime() + LOOKAHEAD_MS;
}

/** The person a plan rests on now: its stored taker, else the one calendar it is on. */
export function planRestsOn(plan: ClashPlan): string | null {
  return plan.takerId ?? (plan.holders.length === 1 ? (plan.holders[0] ?? null) : null);
}

function spanKey(key: string, span: Span): string {
  return `${key}@${span.start.toISOString()}/${span.end.toISOString()}`;
}

/**
 * Every clash ahead, soonest first, one per collision: each plan is the subject of one
 * clash at most. The caller skips the ones the group was already sent.
 */
export function findGroupClashes(input: GroupClashInput): GroupClash[] {
  const plans = input.plans
    .filter((plan) => !plan.claimed && watchedPlan(plan, input.now))
    .sort((a, b) => a.start.getTime() - b.start.getTime() || a.key.localeCompare(b.key));
  const people = new Map(input.people.map((person) => [person.id, person]));
  const visible = input.people.filter((person) => person.calendar).map((person) => person.id);
  const named = (id: string) => (people.get(id)?.name ?? '').length > 0;
  // A plan under way, or one someone took in the group, is no clash of its own, but
  // whoever has it is not free until it ends.
  const held: ClashBusy[] = input.plans
    .filter(
      (plan) =>
        takesTime(plan, input.now) && (plan.claimed || plan.start.getTime() <= input.now.getTime()),
    )
    .flatMap((plan) =>
      (plan.takerId ? [plan.takerId] : plan.holders).map((personId) => ({
        key: plan.key,
        personId,
        start: plan.start,
        end: plan.end,
        known: plan.takerId !== null,
      })),
    );
  const taken = [...input.busy, ...held];
  const busyThen = (id: string, span: Span): ClashBusy | null =>
    taken.find(
      (block) =>
        block.personId === id &&
        (block.known || people.get(id)?.calendar === true) &&
        overlaps(block, span),
    ) ?? null;
  const freeFor = (id: string, plan: ClashPlan): boolean =>
    people.get(id)?.calendar === true &&
    busyThen(id, plan) === null &&
    !plans.some(
      (other) => other.key !== plan.key && planRestsOn(other) === id && overlaps(other, plan),
    );
  // Who could do it as things stand: the person it rests on unless their calendar shows
  // them busy, else anyone free on a calendar Hale can see.
  const options = (plan: ClashPlan): string[] => {
    const owner = planRestsOn(plan);
    if (owner !== null && busyThen(owner, plan) === null) return [owner];
    return visible.filter((id) => freeFor(id, plan));
  };
  const covered = (a: ClashPlan, b: ClashPlan): boolean =>
    options(a).some((x) => options(b).some((y) => x !== y));

  const describe = (first: ClashPlan, second: GroupClash['second']): GroupClash => {
    const pair = 'plan' in second ? [first, second.plan] : [first];
    let suggested: GroupClash['suggested'] = null;
    let alsoFree: string[] = [];
    for (const plan of [...pair].reverse()) {
      const [pick, ...rest] = visible.filter(
        (id) => id !== planRestsOn(plan) && freeFor(id, plan) && named(id),
      );
      if (pick) {
        suggested = { personId: pick, planKey: plan.key };
        alsoFree = rest;
        break;
      }
    }
    // Sorted: a collision is the set of things in it, so a claim that turns one of its plans
    // into the claimer's busy time is still the alert the group already has.
    const parts = pair.map((plan) => spanKey(plan.key, plan));
    if ('busy' in second) parts.push(spanKey(second.busy.key, second.busy));
    parts.sort();
    return {
      dedupeKey: `linq-group:clash:${createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32)}`,
      first,
      second,
      restsOn: Object.fromEntries(pair.map((plan) => [plan.key, planRestsOn(plan)])),
      suggested,
      alsoFree,
      busy: input.people
        .filter(
          (person) => named(person.id) && pair.some((plan) => busyThen(person.id, plan) !== null),
        )
        .map((person) => person.id),
      couldAsk: input.people
        .filter(
          (person) =>
            !person.calendar &&
            person.name.length > 0 &&
            !pair.some(
              (plan) => planRestsOn(plan) === person.id || busyThen(person.id, plan) !== null,
            ),
        )
        .map((person) => person.id),
    };
  };

  const clashes: GroupClash[] = [];
  const told = new Set<string>();
  for (const [index, plan] of plans.entries()) {
    if (told.has(plan.key)) continue;
    const owner = planRestsOn(plan);
    const blocked = owner === null ? null : busyThen(owner, plan);
    if (blocked) {
      clashes.push(describe(plan, { busy: blocked }));
      told.add(plan.key);
      continue;
    }
    const later = plans
      .slice(index + 1)
      .find((other) => !told.has(other.key) && overlaps(plan, other) && !covered(plan, other));
    if (later) {
      clashes.push(describe(plan, { plan: later }));
      told.add(plan.key);
      told.add(later.key);
      continue;
    }
    // A third plan at the same time still gets its own alert, against one already named.
    const earlier = plans
      .slice(0, index)
      .find((other) => told.has(other.key) && overlaps(plan, other) && !covered(other, plan));
    if (earlier) {
      clashes.push(describe(earlier, { plan }));
      told.add(plan.key);
    }
  }
  return clashes;
}

/** A calendar row as `parent_calendar_blocks` keeps it, after teen titles are dropped. */
export interface ClashSourceBlock {
  integrationId: string;
  eventId: string;
  userId: string;
  start: Date | null;
  end: Date | null;
  allDay: boolean;
  kidRelated: boolean;
  title: string | null;
  status: string;
}

/** A household plan Hale holds (`family_events`, never a mirror of a parent's calendar). */
export interface ClashSourceEvent {
  id: string;
  title: string;
  start: Date;
  end: Date | null;
  /** A teen's or a health item: its taker is busy then, and nothing else is said. */
  private: boolean;
  owner: { kind: 'parent'; userId: string } | { kind: 'named'; label: string } | null;
  /** When the owner was set. A claim made in the group after it wins. */
  ownerSince: Date | null;
  placedGoogleEventId: string | null;
  /** The calendar connection that holds `placedGoogleEventId`. Google event ids are only
   * unique within one calendar, so a copy is matched on both. */
  placedGoogleIntegrationId: string | null;
}

/** A stored who-takes decision: who, since when, and whether the group settled it. */
export interface ClashDecision {
  takerId: string;
  at: Date;
  /** Said in the group: the taker took it themselves, or a poll vote named them. */
  claim: boolean;
}

/** The same normalization the stored who-takes decisions are keyed by. */
export function clashTitleNorm(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Plans, busy time, and named takers from what Hale may read. A kid item on two calendars,
 * or a plan Hale placed on a calendar, is one plan with every holder. An all-day item is
 * not a taken hour (Google marks most of them free), so it neither clashes nor makes
 * anyone busy. An item with no end is skipped: no end time is invented. On a plan Hale
 * holds, a claim made in the group outranks a duty owner set before it, never after.
 */
export function clashCalendar(input: {
  blocks: readonly ClashSourceBlock[];
  events: readonly ClashSourceEvent[];
  /** A stored who-takes decision for this start and title, or null. */
  decided: (startIso: string, titleNorm: string) => ClashDecision | null;
}): { plans: ClashPlan[]; busy: ClashBusy[]; named: ClashPerson[] } {
  interface Draft {
    key: string;
    title: string;
    start: Date;
    end: Date;
    holders: Set<string>;
    takerId: string | null;
    claimed: boolean;
    rows: { integrationId: string; eventId: string }[];
  }
  const drafts: Draft[] = [];
  const bySignature = new Map<string, Draft>();
  const byPlaced = new Map<string, Draft>();
  const privatePlaced = new Set<string>();
  /** A private plan whose connection is gone: its id alone still hides any matching row. */
  const privatePlacedAnywhere = new Set<string>();
  const copyKey = (integrationId: string, eventId: string) => `${integrationId}\u0000${eventId}`;
  const busy: ClashBusy[] = [];
  const named = new Map<string, ClashPerson>();
  const signature = (title: string, start: Date, end: Date) =>
    `${clashTitleNorm(title)}|${start.getTime()}|${end.getTime()}`;

  for (const event of input.events) {
    if (event.private && event.placedGoogleEventId) {
      if (event.placedGoogleIntegrationId) {
        privatePlaced.add(copyKey(event.placedGoogleIntegrationId, event.placedGoogleEventId));
      } else {
        privatePlacedAnywhere.add(event.placedGoogleEventId);
      }
    }
    if (!event.end || event.end.getTime() <= event.start.getTime()) continue;
    let takerId: string | null = null;
    let label: string | null = null;
    if (event.owner?.kind === 'parent') takerId = event.owner.userId;
    if (event.owner?.kind === 'named' && event.owner.label.trim()) {
      label = event.owner.label.trim();
      takerId = `named:${label}`;
    }
    if (event.private) {
      if (label && takerId) named.set(takerId, { id: takerId, name: label, calendar: false });
      if (takerId) {
        busy.push({
          key: `plan:${event.id}`,
          personId: takerId,
          start: event.start,
          end: event.end,
          known: true,
        });
      }
      continue;
    }
    const word = input.decided(event.start.toISOString(), clashTitleNorm(event.title));
    const claim =
      word?.claim &&
      (takerId === null ||
        event.ownerSince === null ||
        word.at.getTime() >= event.ownerSince.getTime())
        ? word
        : null;
    if (claim) takerId = claim.takerId;
    else if (label && takerId) named.set(takerId, { id: takerId, name: label, calendar: false });
    const draft: Draft = {
      key: `plan:${event.id}`,
      title: event.title,
      start: event.start,
      end: event.end,
      holders: new Set(),
      takerId,
      claimed: claim !== null,
      rows: [],
    };
    drafts.push(draft);
    bySignature.set(signature(event.title, event.start, event.end), draft);
    if (event.placedGoogleEventId && event.placedGoogleIntegrationId) {
      byPlaced.set(copyKey(event.placedGoogleIntegrationId, event.placedGoogleEventId), draft);
    }
  }

  for (const block of input.blocks) {
    if (block.status === 'cancelled' || block.allDay || !block.start || !block.end) continue;
    if (block.end.getTime() <= block.start.getTime()) continue;
    const row = { integrationId: block.integrationId, eventId: block.eventId };
    const copy = copyKey(block.integrationId, block.eventId);
    const hidden = privatePlaced.has(copy) || privatePlacedAnywhere.has(block.eventId);
    const placed = hidden ? undefined : byPlaced.get(copy);
    if (placed) {
      placed.holders.add(block.userId);
      placed.rows.push(row);
      continue;
    }
    if (!block.kidRelated || !block.title || hidden) {
      busy.push({
        key: `busy:${block.integrationId}:${block.eventId}`,
        personId: block.userId,
        start: block.start,
        end: block.end,
        known: false,
      });
      continue;
    }
    const sig = signature(block.title, block.start, block.end);
    let draft = bySignature.get(sig);
    if (!draft) {
      const startIso = block.start.toISOString();
      const word = input.decided(startIso, clashTitleNorm(block.title));
      draft = {
        key: `cal:${clashTitleNorm(block.title)}@${startIso}/${block.end.toISOString()}`,
        title: block.title.trim(),
        start: block.start,
        end: block.end,
        holders: new Set(),
        takerId: word?.takerId ?? null,
        claimed: word?.claim ?? false,
        rows: [],
      };
      drafts.push(draft);
      bySignature.set(sig, draft);
    }
    draft.holders.add(block.userId);
    draft.rows.push(row);
  }

  return {
    plans: drafts.map((draft) => ({ ...draft, holders: [...draft.holders] })),
    busy,
    named: [...named.values()],
  };
}

export type GroupConflictItem =
  | { kind: 'plan'; title: string; day: string; start: string; end: string; has: string | null }
  | { kind: 'busy'; who: string | null };

/** What the model is given: facts code checked, and nothing it may not say to the group. */
export interface GroupConflictLineInput {
  language: ReplyLanguage;
  /** The family's kids the group may hear about, so the model can tell one child's two plans. */
  kids: readonly string[];
  items: readonly GroupConflictItem[];
  suggested: { name: string; takes: string } | null;
  alsoFree: readonly string[];
  busy: readonly string[];
  couldAsk: readonly string[];
  /** A who-takes poll Hale can send after the alert: the plan it asks about, the names on it. */
  poll: { takes: string; choices: readonly string[] } | null;
}

/** The who-takes poll a clash alert may carry. */
export interface ClashPollOffer {
  /** The plan it asks who takes. */
  plan: ClashPlan;
  /** Everyone on it, by the name the group knows, each with an account a vote can name. */
  people: readonly { id: string; name: string }[];
}

/**
 * The poll a clash may carry, or null. It asks who takes one plan: the one the alert hands
 * over, or the one plan in a clash with someone's busy time. Two plans with nobody to hand
 * one to stay an open ask in words. The names are everyone in the chat with an account, as
 * stored, so none is invented; fewer than two, or two that read the same, is no poll.
 */
export function clashPollOffer(
  clash: GroupClash,
  people: readonly ClashPerson[],
): ClashPollOffer | null {
  const pair = 'plan' in clash.second ? [clash.first, clash.second.plan] : [clash.first];
  const plan = clash.suggested
    ? pair.find((row) => row.key === clash.suggested?.planKey)
    : 'busy' in clash.second
      ? clash.first
      : undefined;
  if (!plan) return null;
  const named = people
    .filter((person) => !person.id.startsWith('named:'))
    .map((person) => ({ id: person.id, name: person.name.trim() }))
    .filter((person) => person.name.length > 0);
  const distinct = new Set(named.map((person) => person.name.toLowerCase()));
  if (named.length < 2 || distinct.size < named.length) return null;
  return { plan, people: named };
}

/**
 * The poll's last option as the model wrote it, or null: empty, a link, or a name on the
 * poll, which a tap could not be told apart from.
 */
export function clashPollPass(choices: readonly string[], pass: string): string | null {
  const body = groupConflictTextUsable(pass);
  if (!body) return null;
  const lower = body.toLowerCase();
  return choices.some((name) => name.trim().toLowerCase() === lower) ? null : body;
}

/** The poll as it goes: each name as stored, then the model's pass, all about one plan. */
export function clashPollOptions(
  offer: ClashPollOffer,
  pass: string,
  subjectKey: string,
): PollOptionWrite[] | null {
  const trailing = clashPollPass(
    offer.people.map((person) => person.name),
    pass,
  );
  if (!trailing) return null;
  return [
    ...offer.people.map((person) => ({
      text: person.name,
      pollKind: 'who_takes',
      subjectKey,
      choiceKind: 'parent',
      choiceValue: person.id,
    })),
    {
      text: trailing,
      pollKind: 'who_takes',
      subjectKey,
      choiceKind: 'figure_it_out',
      choiceValue: null,
    },
  ];
}

function localDay(date: Date, timeZone: string, language: ReplyLanguage): string {
  return new Intl.DateTimeFormat(localeFor(language), {
    timeZone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(date);
}

function localClock(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const read = (type: string) => parts.find((part) => part.type === type)?.value ?? '00';
  return `${read('hour')}:${read('minute')}`;
}

/** A plan's local day and 24-hour start and end, as the model is given them. */
export function planWhen(
  plan: Pick<ClashPlan, 'start' | 'end'>,
  timeZone: string,
  language: ReplyLanguage,
): { day: string; start: string; end: string } {
  return {
    day: localDay(plan.start, timeZone, language),
    start: localClock(plan.start, timeZone),
    end: localClock(plan.end, timeZone),
  };
}

export function groupConflictLineInput(
  clash: GroupClash,
  context: {
    people: readonly ClashPerson[];
    kids: readonly string[];
    timeZone: string;
    language: ReplyLanguage;
    /** The poll Hale may send with it: null when LINQ_POLLS is off or none fits. */
    poll: ClashPollOffer | null;
  },
): GroupConflictLineInput {
  const nameOf = (id: string | null | undefined): string | null =>
    (id ? context.people.find((person) => person.id === id)?.name : null) || null;
  const names = (ids: readonly string[]) =>
    ids.map((id) => nameOf(id)).filter((name): name is string => name !== null);
  const plan = (row: ClashPlan): GroupConflictItem => ({
    kind: 'plan',
    title: row.title,
    ...planWhen(row, context.timeZone, context.language),
    has: nameOf(clash.restsOn[row.key]),
  });
  const second: GroupConflictItem =
    'plan' in clash.second
      ? plan(clash.second.plan)
      : { kind: 'busy', who: nameOf(clash.second.busy.personId) };
  const plans = 'plan' in clash.second ? [clash.first, clash.second.plan] : [clash.first];
  const takes = plans.find((row) => row.key === clash.suggested?.planKey);
  const suggestedName = nameOf(clash.suggested?.personId);
  return {
    language: context.language,
    kids: [...context.kids],
    items: [plan(clash.first), second],
    suggested: takes && suggestedName ? { name: suggestedName, takes: takes.title } : null,
    alsoFree: names(clash.alsoFree),
    busy: names(clash.busy),
    couldAsk: names(clash.couldAsk),
    poll: context.poll
      ? {
          takes: context.poll.plan.title,
          choices: context.poll.people.map((person) => person.name),
        }
      : null,
  };
}

export function groupConflictUserMessage(input: GroupConflictLineInput): string {
  return JSON.stringify(input);
}

/** The writer's forced tool, shared with the eval so both ask the model the same thing. */
export const GROUP_CONFLICT_TOOL = {
  name: 'group_conflict_alert',
  description: 'The one message Hale posts to the family group about this clash.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string' }, figureItOut: { type: 'string' } },
    required: ['text'],
  },
} as const;

/** A spend bound on the write (rule #7), not a length for the message. */
export const GROUP_CONFLICT_MAX_TOKENS = 400;

/**
 * The text as it may go out, or null: empty, or a link. Its facts, privacy, one ask and
 * voice are the eval judge's call, not a count of anything here.
 */
export function groupConflictTextUsable(text: string): string | null {
  const body = text.trim();
  if (body.length === 0) return null;
  if (/https?:\/\/|www\./i.test(body)) return null;
  return body;
}

/**
 * The alert as it may go out, or null. A poll goes only when one was offered and the model
 * wrote its last option; leaving that out is no poll. A message written for a poll whose
 * last option cannot go is refused whole: it would ask about a poll that is not there.
 */
export function groupConflictAlertUsable(
  input: Pick<GroupConflictLineInput, 'poll'>,
  value: { text: string; figureItOut?: string | null },
): { text: string; figureItOut: string | null } | null {
  const text = groupConflictTextUsable(value.text);
  if (!text) return null;
  const pass = input.poll ? (value.figureItOut ?? '').trim() : '';
  if (!input.poll || !pass) return { text, figureItOut: null };
  const figureItOut = clashPollPass(input.poll.choices, pass);
  return figureItOut ? { text, figureItOut } : null;
}
