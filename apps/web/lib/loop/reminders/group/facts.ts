import type { ReplyLanguage } from '~/lib/channel/language';
import type { TurnPlan } from './plan';
import type { ReminderFor } from './policy';
import { type ConfirmFacts, type ReminderTextFacts, whenFact } from './voice';

/**
 * The facts the voice writes from, built in one place so the runtime and the eval
 * (apps/worker/evals/group-reminder-eval.mjs) hand the model exactly the same thing.
 */

export function confirmFacts(input: {
  language: ReplyLanguage;
  asker: string | null;
  memberWords: string;
  now: Date;
  timeZone: string;
  plan: Pick<TurnPlan, 'set' | 'needsTime' | 'notSet'>;
  cancelled: readonly { what: string | null; deliverAt: Date }[];
}): ConfirmFacts {
  const { timeZone } = input;
  return {
    kind: 'confirm',
    language: input.language,
    audience: 'group',
    asker: input.asker,
    memberWords: input.memberWords,
    now: whenFact(input.now, timeZone),
    set: input.plan.set.map((planned) => ({
      forName: planned.forKind === 'person' ? planned.forName : null,
      forEveryone: planned.forKind === 'everyone',
      what: planned.what,
      when: whenFact(planned.deliverAt, timeZone),
      askedFor: planned.moved ? whenFact(planned.askedFor, timeZone) : null,
      moved: planned.moved,
      arrives: planned.delivery === 'direct' ? 'private_text' : 'here',
      privateAsked: planned.privateAsked,
    })),
    cancelled: input.cancelled.map((row) => ({
      what: row.what ?? '',
      when: whenFact(row.deliverAt, timeZone),
    })),
    needsTime: input.plan.needsTime.map((ask) => ({
      forName: ask.forKind === 'person' ? ask.forName : null,
      forEveryone: ask.forKind === 'everyone',
      what: ask.what,
      day: ask.day,
    })),
    notSet: input.plan.notSet.map(({ forName, what, why }) => ({ forName, what, why })),
  };
}

export interface DueReminder {
  forKind: ReminderFor;
  delivery: 'group' | 'direct';
  language: ReplyLanguage;
  what: string;
  askedForAt: Date;
  deliverAt: Date;
}

/**
 * `recipientName` is the seat's first name, or the name as the asker said it, for a
 * reminder for someone else. A reminder for the asker is named by `askerName`.
 */
export function reminderFacts(input: {
  reminder: DueReminder;
  askerName: string | null;
  recipientName: string | null;
  now: Date;
  timeZone: string;
}): ReminderTextFacts {
  const { reminder, askerName, timeZone } = input;
  const forName =
    reminder.forKind === 'sender'
      ? askerName
      : reminder.forKind === 'person'
        ? input.recipientName
        : null;
  return {
    kind: 'reminder',
    language: reminder.language,
    audience: reminder.delivery === 'direct' ? 'direct' : 'group',
    asker: askerName,
    memberWords: null,
    now: whenFact(input.now, timeZone),
    forName,
    forEveryone: reminder.forKind === 'everyone',
    askedByName: reminder.forKind === 'sender' ? null : askerName,
    what: reminder.what,
    askedFor:
      reminder.askedForAt.getTime() === reminder.deliverAt.getTime()
        ? null
        : whenFact(reminder.askedForAt, timeZone),
  };
}
