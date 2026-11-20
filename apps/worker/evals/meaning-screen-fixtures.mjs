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

  // VIL-723 · the activity-decision pickers folded into the read: paraphrases in English,
  // French and Chinese, and the registration outcomes and questions that are not a pick.
  {
    id: 'activity-picked-paraphrase-en',
    screen: 'activity_decision',
    text: "we'll do swim for Maya on Tuesdays at 4",
    expect: { decision: 'picked' },
  },
  {
    id: 'activity-picked-fr',
    screen: 'activity_decision',
    text: 'on prend la natation pour Maya, mardi 16 h',
    expect: { decision: 'picked' },
  },
  {
    id: 'activity-picked-zh',
    screen: 'activity_decision',
    text: '玛雅周二下午四点上游泳课，就定这个了',
    expect: { decision: 'picked' },
  },
  {
    id: 'activity-passed-paraphrase-en',
    screen: 'activity_decision',
    text: "let's skip the art class for Maya",
    expect: { decision: 'passed' },
  },
  {
    id: 'activity-passed-fr',
    screen: 'activity_decision',
    text: 'on laisse tomber le dessin pour Maya',
    expect: { decision: 'passed' },
  },
  {
    id: 'activity-registration-outcome-not-a-pick',
    screen: 'activity_decision',
    text: 'we got in to swim for Maya, Tuesday at 4!',
    expect: { decision: 'none' },
  },
  {
    id: 'activity-question-not-a-pick',
    screen: 'activity_decision',
    text: 'should we do swim for Maya on Tuesday at 4?',
    expect: { decision: 'none' },
  },

  // VIL-723 · what a parent asked of Hale's memory, in English, French and Chinese. Gold is
  // the request kind production acts on; unrelated texts, and a "forget it" that drops a
  // plan, are not claimed.
  {
    id: 'memory-list-en',
    screen: 'memory_request',
    text: 'what do you know about us?',
    expect: { memory: 'list' },
  },
  {
    id: 'memory-list-paraphrase-en',
    screen: 'memory_request',
    text: 'what have you got saved on our family so far',
    expect: { memory: 'list' },
  },
  {
    id: 'memory-list-fr',
    screen: 'memory_request',
    text: "qu'est-ce que tu sais sur nous ?",
    expect: { memory: 'list' },
  },
  {
    id: 'memory-list-zh',
    screen: 'memory_request',
    text: '你都记得我们家哪些事？',
    expect: { memory: 'list' },
  },
  {
    id: 'memory-forget-en',
    screen: 'memory_request',
    text: 'please forget that Maya does swim on Saturdays',
    expect: { memory: 'forget' },
  },
  {
    id: 'memory-forget-paraphrase-en',
    screen: 'memory_request',
    text: "can you stop keeping our home address, I'd rather you didn't have it",
    expect: { memory: 'forget' },
  },
  {
    id: 'memory-forget-fr',
    screen: 'memory_request',
    text: "oublie ce que je t'ai dit sur le hockey",
    expect: { memory: 'forget' },
  },
  {
    id: 'memory-forget-zh',
    screen: 'memory_request',
    text: '把游泳课那条忘掉吧',
    expect: { memory: 'forget' },
  },
  {
    id: 'memory-correct-en',
    screen: 'memory_request',
    text: "no, that's old - her swim class is on Thursdays now",
    expect: { memory: 'correct' },
  },
  {
    id: 'memory-correct-fr',
    screen: 'memory_request',
    text: "c'est faux, on habite à Laval maintenant",
    expect: { memory: 'correct' },
  },
  {
    id: 'memory-correct-zh',
    screen: 'memory_request',
    text: '你记错了，她的老师现在是王老师',
    expect: { memory: 'correct' },
  },
  {
    id: 'memory-unrelated-question-en',
    screen: 'memory_request',
    text: 'what time is swim tomorrow?',
    expect: { memory: 'none' },
  },
  {
    id: 'memory-unrelated-dismissal-en',
    screen: 'memory_request',
    text: "forget it, I'll book it myself",
    expect: { memory: 'none' },
  },
  {
    id: 'memory-unrelated-dismissal-fr',
    screen: 'memory_request',
    text: 'oublie ça, on verra demain',
    expect: { memory: 'none' },
  },
  {
    id: 'memory-unrelated-question-zh',
    screen: 'memory_request',
    text: '明天游泳课几点开始？',
    expect: { memory: 'none' },
  },
  {
    id: 'memory-unrelated-new-fact-en',
    screen: 'memory_request',
    text: 'Maya started piano this week',
    expect: { memory: 'none' },
  },

  // VIL-723 · which remembered fact a forget or a correction means, by ref, across
  // languages; nothing when nothing is named or nothing matches.
  {
    id: 'memory-target-forget-zh',
    screen: 'memory_target',
    text: '把游泳课那条忘掉吧',
    facts: [
      "f1: swimming: saturday class (source: Hale's own guess; kept until they change it)",
      'f2: district: midtown (source: the parent told Hale; kept until they change it)',
    ],
    expect: { refs: ['f1'] },
  },
  {
    id: 'memory-target-forget-en',
    screen: 'memory_target',
    text: "please don't keep where we live",
    facts: [
      "f1: swimming: saturday class (source: Hale's own guess; kept until they change it)",
      'f2: district: midtown (source: the parent told Hale; kept until they change it)',
    ],
    expect: { refs: ['f2'] },
  },
  {
    id: 'memory-target-correct-fr',
    screen: 'memory_target',
    text: "la natation, c'est le jeudi maintenant",
    facts: [
      "f1: swimming: saturday class (source: Hale's own guess; kept until they change it)",
      'f2: district: midtown (source: the parent told Hale; kept until they change it)',
    ],
    expect: { refs: ['f1'] },
  },
  {
    id: 'memory-target-nothing-matches',
    screen: 'memory_target',
    text: "forget our dog's name",
    facts: [
      "f1: swimming: saturday class (source: Hale's own guess; kept until they change it)",
      'f2: district: midtown (source: the parent told Hale; kept until they change it)',
    ],
    expect: { refs: [] },
  },
  {
    id: 'memory-target-nothing-named',
    screen: 'memory_target',
    text: 'forget that',
    facts: [
      "f1: swimming: saturday class (source: Hale's own guess; kept until they change it)",
      'f2: district: midtown (source: the parent told Hale; kept until they change it)',
    ],
    expect: { refs: [] },
  },
];
