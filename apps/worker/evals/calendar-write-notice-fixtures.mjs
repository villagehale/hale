// The calendar write notice — the corpus (VIL-454 T6).
//
// Expectations come from the SPEC (packages/agent/skills/calendar-write-notice.md): one
// text telling the parent how the write to their own calendar went. No fixed copy and
// no wording checks: a judge reads the facts and the tone. Includes zh and fr.

const SWIM = { title: 'Swim lesson', when: 'Sat, Nov 7 at 10:00 AM', where: 'Y on Main' };
const LINK = 'https://app.villagehale.com/c/abc123';

export const CALENDAR_WRITE_NOTICE_FIXTURES = [
  {
    id: 'en-added',
    args: {
      op: 'create',
      report: { status: 'written', googleEventId: 'g1' },
      event: SWIM,
      connectLink: null,
      language: 'en',
    },
    watchFor: 'Says the swim lesson is on their calendar, with the time and place as given.',
  },
  {
    id: 'en-updated',
    args: {
      op: 'update',
      report: { status: 'written', googleEventId: 'g1' },
      event: { ...SWIM, when: 'Sun, Nov 8 at 9:00 AM' },
      connectLink: null,
      language: 'en',
    },
    watchFor: 'Says it now reads Sunday 9:00 AM. No invented old time.',
  },
  {
    id: 'fr-removed',
    args: {
      op: 'delete',
      report: { status: 'written', googleEventId: 'g1' },
      event: { title: 'Cours de natation', when: 'sam. 7 nov. à 10 h', where: null },
      connectLink: null,
      language: 'fr',
    },
    watchFor: 'French, tu, real accents. Says it is off their calendar.',
  },
  {
    id: 'en-no-calendar',
    args: {
      op: 'create',
      report: { status: 'skipped', reason: 'not_connected' },
      event: SWIM,
      connectLink: LINK,
      language: 'en',
    },
    watchFor:
      'Nothing went on any calendar. Offers the link to connect one, no pressure. Never implies it was added.',
  },
  {
    id: 'zh-needs-permission',
    args: {
      op: 'create',
      report: { status: 'skipped', reason: 'scope_missing' },
      event: { title: '游泳课', when: '11月7日周六上午10点', where: '社区中心' },
      connectLink: LINK,
      language: 'zh',
    },
    watchFor:
      'Chinese. Calendar is connected but read-only, so nothing was written; the link lets them allow it.',
  },
  {
    id: 'en-could-not-write',
    args: {
      op: 'create',
      report: { status: 'failed', reason: 'google_error' },
      event: SWIM,
      connectLink: null,
      language: 'en',
    },
    watchFor:
      'States only that it did not go through this time: no blame, no system explanation, no link, and no offer to retry or any other next step Hale was never given.',
  },
];
