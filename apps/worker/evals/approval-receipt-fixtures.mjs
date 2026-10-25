// The approval receipt — the corpus (VIL-454 T6 3/3). Not recorded.
//
// Expectations come from the SPEC (packages/agent/skills/approval-receipt.md). No fixed
// copy and no wording checks: a judge reads the facts and the tone. Includes fr and zh.

export const APPROVAL_RECEIPT_FIXTURES = [
  {
    id: 'en-approved-add',
    args: ['approved', 'calendar_add', 'en'],
    watchFor: 'Acknowledges the go-ahead. Does not claim it is already on the calendar.',
  },
  {
    id: 'en-declined-add',
    args: ['declined', 'calendar_add', 'en'],
    watchFor: 'Acknowledges the no plainly. No persuasion, no follow-up offer.',
  },
  {
    id: 'en-undone',
    args: ['undone', 'calendar_add', 'en'],
    watchFor: 'Says the last change is taken back. Nothing invented about what it was.',
  },
  {
    id: 'fr-approved-move',
    args: ['approved', 'calendar_move', 'fr'],
    watchFor: 'French, tu. Acknowledges the go-ahead on the move without claiming it is done.',
  },
  {
    id: 'zh-declined-cancel',
    args: ['declined', 'calendar_cancel', 'zh'],
    watchFor: 'Chinese. Acknowledges the no; the event stays as it was.',
  },
  {
    id: 'zh-undone',
    args: ['undone', 'calendar_move', 'zh'],
    watchFor: 'Chinese. Says the change is taken back.',
  },
];
