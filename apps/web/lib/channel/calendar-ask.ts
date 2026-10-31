import type { PendingAction } from '~/lib/channel/router/approval';
import type { OpenQuestion } from '~/lib/channel/router/open-questions';
import type { ReplyReading } from '~/lib/channel/router/resolve';

/**
 * VIL-513 — one calendar ask, one question.
 *
 * A coach "Add … to calendar?" drafts a `calendar_add` and, after the send, is also
 * recorded as a calendar offer. Those are the same decision. Listed as two questions,
 * a bare YES is ambiguous (or not answerable, when the reviewer has not cleared the
 * draft) and the turn falls through to the coach, which drafts the same add again.
 */

export function calendarTitlesEqual(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

export function calendarInstantsEqual(left: string, right: string): boolean {
  const a = new Date(left).getTime();
  const b = new Date(right).getTime();
  return !Number.isNaN(a) && a === b;
}

/**
 * The reviewer-approved `calendar_add` this offer is asking about, or null.
 *
 * One draft with this title is that draft, even when the offer's instant was read
 * a minute off the sentence. Two drafts with the title are told apart by the instant,
 * and only by an exact match — never by picking the newest.
 */
export function matchApprovedCalendarAdd(
  approvals: readonly PendingAction[],
  offer: { title: string; startsAt: string },
): PendingAction | null {
  const titled = approvals.filter(
    (action) =>
      action.actionType === 'calendar_add' &&
      action.reviewerApproved &&
      action.occasion !== undefined &&
      calendarTitlesEqual(action.occasion.title, offer.title),
  );
  if (titled.length === 1) return titled[0] ?? null;
  const timed = titled.filter(
    (action) =>
      action.occasion !== undefined &&
      calendarInstantsEqual(action.occasion.startsAt, offer.startsAt),
  );
  return timed.length === 1 ? (timed[0] ?? null) : null;
}

/**
 * The calendar-offer reader should read this turn when every question a YES could
 * land on is a calendar offer.
 *
 * A draft the reviewer has not cleared is still listed (the parent can decline it)
 * but its YES is closed. It must not force the general resolver, which then returns
 * `not_answerable` and hands the turn to the coach.
 *
 * Returns the offers to show the reader — not the whole list — so a not-answerable
 * draft sitting beside them cannot make a bare YES ambiguous.
 */
export function questionsForCalendarReader(
  questions: readonly OpenQuestion[],
): readonly OpenQuestion[] | null {
  const offers = questions.filter((question) => question.kind === 'email_alert_add');
  if (offers.length === 0) return null;
  const yesTakes = questions.filter((question) => question.answerable.yes);
  if (yesTakes.length === 0) return null;
  if (!yesTakes.every((question) => question.kind === 'email_alert_add')) return null;
  return offers;
}

/**
 * A YES the calendar reader placed on an offer that IS a drafted calendar add
 * approves that draft. The offer id is not an action id; swapping them is what
 * makes the approval handler the thing that claims the turn.
 */
export function approvalForCalendarYes(
  questions: readonly OpenQuestion[],
  reading: ReplyReading,
): ReplyReading {
  if (reading.status !== 'resolved') return reading;
  if (reading.kind !== 'email_alert_add' || reading.polarity !== 'yes') return reading;
  const offer = questions.find((question) => question.id === reading.questionId);
  if (!offer?.approvesActionId) return reading;
  return {
    status: 'resolved',
    questionId: offer.approvesActionId,
    kind: 'approval',
    polarity: 'yes',
    confidence: reading.confidence,
  };
}

/** Same occasion as a coach offer, among drafts that must not also execute. */
export function unapprovedCalendarAddIds(
  drafts: readonly {
    id: string;
    actionType: string;
    reviewerApproved: boolean;
    occasion: { title: string; startsAt: string } | null;
  }[],
  offer: { title: string; startsAt: string },
): string[] {
  const titled = drafts.filter(
    (draft) =>
      draft.actionType === 'calendar_add' &&
      !draft.reviewerApproved &&
      draft.occasion !== null &&
      calendarTitlesEqual(draft.occasion.title, offer.title),
  );
  if (titled.length === 1) return [titled[0]?.id].filter((id): id is string => id !== undefined);
  return titled
    .filter(
      (draft) =>
        draft.occasion !== null && calendarInstantsEqual(draft.occasion.startsAt, offer.startsAt),
    )
    .map((draft) => draft.id);
}
