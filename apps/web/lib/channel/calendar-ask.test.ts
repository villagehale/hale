import { describe, expect, it } from 'vitest';
import type { PendingAction } from '~/lib/channel/router/approval';
import type { OpenQuestion } from '~/lib/channel/router/open-questions';
import {
  approvalForCalendarYes,
  calendarInstantsClose,
  matchApprovedCalendarAdd,
  pairedDraftForCalendarNo,
  questionsForCalendarReader,
  unapprovedCalendarAddIds,
} from './calendar-ask';

const START = '2026-10-31T19:00:00.000Z';

function draft(
  over: Partial<PendingAction> & Pick<PendingAction, 'actionId' | 'reviewerApproved'>,
): PendingAction {
  return {
    actionType: 'calendar_add',
    occasion: { title: 'Trunk or Treat', startsAt: START },
    ...over,
  };
}

function offer(id: string, over: Partial<OpenQuestion> = {}): OpenQuestion {
  return {
    id,
    kind: 'email_alert_add',
    description: 'An offer to put Trunk or Treat on your week',
    subject: 'putting Trunk or Treat on your week',
    answerable: { yes: true, no: true },
    askedAt: new Date('2026-10-30T21:40:00.000Z'),
    solicited: true,
    ...over,
  };
}

function approvalQuestion(over: Partial<OpenQuestion> = {}): OpenQuestion {
  return {
    id: 'a-1',
    kind: 'approval',
    description: 'Add to your calendar',
    subject: 'add to your calendar',
    answerable: { yes: false, no: true },
    askedAt: null,
    solicited: false,
    ...over,
  };
}

describe('matchApprovedCalendarAdd', () => {
  it('is the one approved draft with that title', () => {
    const matched = draft({ actionId: 'a-1', reviewerApproved: true });
    expect(
      matchApprovedCalendarAdd([matched, draft({ actionId: 'a-2', reviewerApproved: false })], {
        title: '  trunk or treat ',
        startsAt: '2026-10-31T19:01:00.000Z',
      })?.actionId,
    ).toBe('a-1');
  });

  it('does not pick between two approved drafts that share a title unless the instant matches', () => {
    const early = draft({
      actionId: 'early',
      reviewerApproved: true,
      occasion: { title: 'Gymnastics', startsAt: '2026-10-04T13:00:00.000Z' },
    });
    const late = draft({
      actionId: 'late',
      reviewerApproved: true,
      occasion: { title: 'Gymnastics', startsAt: '2026-10-04T18:00:00.000Z' },
    });
    expect(
      matchApprovedCalendarAdd([early, late], {
        title: 'Gymnastics',
        startsAt: '2026-10-04T18:00:00.000Z',
      })?.actionId,
    ).toBe('late');
    expect(
      matchApprovedCalendarAdd([early, late], {
        title: 'Gymnastics',
        startsAt: '2026-10-04T12:00:00.000Z',
      }),
    ).toBeNull();
  });

  it('ignores an unrelated approved draft', () => {
    expect(
      matchApprovedCalendarAdd(
        [
          draft({
            actionId: 'swim',
            reviewerApproved: true,
            occasion: { title: 'Swim lessons', startsAt: START },
          }),
        ],
        { title: 'Picture day', startsAt: START },
      ),
    ).toBeNull();
  });
});

describe('questionsForCalendarReader', () => {
  it('reads the offer when the only YES that can land is that offer', () => {
    const calendar = offer('offer-1');
    const held = questionsForCalendarReader([approvalQuestion(), calendar]);
    expect(held?.map((question) => question.id)).toEqual(['offer-1']);
  });

  it('does not read the offer when an approved draft is also a YES', () => {
    expect(
      questionsForCalendarReader([
        approvalQuestion({ answerable: { yes: true, no: true } }),
        offer('offer-1'),
      ]),
    ).toBeNull();
  });

  it('still reads when every open question is an offer', () => {
    expect(questionsForCalendarReader([offer('offer-1')])?.map((q) => q.id)).toEqual(['offer-1']);
  });
});

describe('approvalForCalendarYes', () => {
  it('sends a YES on the offer to the drafted action', () => {
    const reading = approvalForCalendarYes([offer('offer-1', { approvesActionId: 'a-1' })], {
      status: 'resolved',
      questionId: 'offer-1',
      kind: 'email_alert_add',
      polarity: 'yes',
      confidence: 'high',
    });
    expect(reading).toEqual({
      status: 'resolved',
      questionId: 'a-1',
      kind: 'approval',
      polarity: 'yes',
      confidence: 'high',
    });
  });

  it('leaves a NO on the offer', () => {
    const reading = {
      status: 'resolved' as const,
      questionId: 'offer-1',
      kind: 'email_alert_add' as const,
      polarity: 'no' as const,
      confidence: 'high' as const,
    };
    expect(
      approvalForCalendarYes([offer('offer-1', { approvesActionId: 'a-1' })], reading),
    ).toEqual(reading);
  });
});

describe('calendarInstantsClose', () => {
  it('treats a minute-off clock as the same instant and morning as distinct from afternoon', () => {
    expect(calendarInstantsClose('2026-09-19T13:00:00.000Z', '2026-09-19T13:01:00.000Z')).toBe(
      true,
    );
    expect(calendarInstantsClose('2026-09-19T13:00:00.000Z', '2026-09-19T20:00:00.000Z')).toBe(
      false,
    );
  });
});

describe('pairedDraftForCalendarNo', () => {
  it('names the draft a NO to the matched offer also declines', () => {
    const reading = {
      status: 'resolved' as const,
      questionId: 'offer-1',
      kind: 'email_alert_add' as const,
      polarity: 'no' as const,
      confidence: 'high' as const,
    };
    expect(pairedDraftForCalendarNo([offer('offer-1', { approvesActionId: 'a-1' })], reading)).toBe(
      'a-1',
    );
    expect(
      pairedDraftForCalendarNo([offer('offer-1', { approvesActionId: 'a-1' })], {
        ...reading,
        polarity: 'yes',
      }),
    ).toBeNull();
    expect(pairedDraftForCalendarNo([offer('offer-1')], reading)).toBeNull();
  });
});

describe('unapprovedCalendarAddIds', () => {
  const zone = 'America/Toronto';

  it('retires the lone same-title draft when the start is the same local day', () => {
    expect(
      unapprovedCalendarAddIds(
        [
          {
            id: 'a-1',
            actionType: 'calendar_add',
            reviewerApproved: false,
            occasion: { title: 'Trunk or Treat', startsAt: '2026-10-08T16:00:00.000Z' },
          },
        ],
        { title: 'Trunk or Treat', startsAt: '2026-10-08T16:01:00.000Z', timeZone: zone },
      ),
    ).toEqual(['a-1']);
  });

  it('keeps a Sunday draft when the offer is Thursday', () => {
    expect(
      unapprovedCalendarAddIds(
        [
          {
            id: 'sunday',
            actionType: 'calendar_add',
            reviewerApproved: false,
            occasion: { title: 'Gymnastics', startsAt: '2026-10-11T16:00:00.000Z' },
          },
        ],
        { title: 'Gymnastics', startsAt: '2026-10-08T16:00:00.000Z', timeZone: zone },
      ),
    ).toEqual([]);
  });
});
