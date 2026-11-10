/**
 * Meaning-screen eval fixtures. One or two per leftover word-list check the
 * sweep replaced. Gold is the structured field production reads; there is no
 * phrase floor.
 */
export const MEANING_SCREEN_FIXTURES = [
  {
    id: 'copy-friend-clear',
    screen: 'copy_friend',
    text: 'Got it. Maya swim is on the list.',
    facts: ['Maya', 'swim'],
    expect: { hit: true, violations: [] },
  },
  {
    id: 'copy-friend-privacy',
    screen: 'copy_friend',
    text: 'I never see your work emails.',
    facts: [],
    expect: { hit: false, violations: ['privacy'] },
  },
  {
    id: 'copy-false-promise-time',
    screen: 'copy_false_promise',
    text: "I'm on it - back in a minute.",
    expect: { hit: false, violations: ['promised_a_time'] },
  },
  {
    id: 'copy-reply-banned-stop',
    screen: 'copy_reply_banned',
    text: 'Reply STOP to unsubscribe.',
    expect: { hit: true },
  },
  {
    id: 'copy-keyword-instruction',
    screen: 'copy_keyword_instruction',
    text: 'Want an intro? Reply YES INTRO or NO INTRO.',
    expect: { hit: true },
  },
  {
    id: 'stated-state-booked',
    screen: 'stated_state',
    text: 'Yes we booked already',
    expect: { hit: true },
  },
  {
    id: 'provider-eye',
    screen: 'provider_access',
    text: 'find me an optometrist',
    expect: { kind: 'eye' },
  },
  {
    id: 'provider-primary',
    screen: 'provider_access',
    text: 'we need a family doctor',
    expect: { kind: 'primary' },
  },
  {
    id: 'activity-picked',
    screen: 'activity_decision',
    text: 'picked swim for Maya, Tuesday at 4:00',
    expect: { decision: 'picked' },
  },
  {
    id: 'health-done',
    screen: 'health_done',
    text: 'done',
    expect: { intent: 'done' },
  },
  {
    id: 'registration-waitlisted',
    screen: 'registration_outcome',
    text: 'waitlisted #15',
    expect: { outcome: 'waitlisted' },
  },
  {
    id: 'connect-gcal',
    screen: 'connect_intent',
    text: 'connect my Google Calendar',
    expect: { action: 'connect', provider: 'gcal' },
  },
  {
    id: 'disconnect-gmail',
    screen: 'connect_intent',
    text: 'disconnect my gmail',
    expect: { action: 'disconnect', provider: 'gmail' },
  },
  {
    id: 'duty-undo',
    screen: 'duty_undo',
    text: 'undo',
    expect: { kind: 'clear' },
  },
  {
    id: 'duty-stop-asking',
    screen: 'duty_stop_asking',
    text: 'please stop asking',
    expect: { hit: true },
  },
  {
    id: 'both-free',
    screen: 'both_free',
    text: 'when are we both free',
    expect: { hit: true },
  },
];
