// VIL-717 corpus for the slow-ask ack: the read (which slow job a text asks for), the
// meaning judge, and the two writers. Texts and lines are eval inputs, never a line Hale
// sends, and never a fallback if a model misses. Nothing here is copied into a skill: the
// skills judge meaning and list no phrases. No child is named; every place is invented.

export const ACK_READ_FIXTURES = [
  {
    id: 'en-registration',
    language: 'en',
    text: 'Can you sign my daughter up for the Saturday swim lessons at the rec centre?',
    expect: 'registration',
  },
  {
    id: 'en-research',
    language: 'en',
    text: 'Could you look into whether the Riverside art camp still has the July week and what it costs?',
    expect: 'research',
  },
  {
    id: 'en-find',
    language: 'en',
    text: 'Any ideas for indoor things to do with a 4 year old this weekend?',
    expect: 'find',
  },
  { id: 'en-none-thanks', language: 'en', text: 'Thanks, that worked perfectly.', expect: 'none' },
  {
    id: 'en-none-known',
    language: 'en',
    text: 'What time is pickup tomorrow again?',
    expect: 'none',
  },
  {
    id: 'fr-registration',
    language: 'fr',
    text: 'Tu peux inscrire mon fils au camp de soccer de la semaine de relâche?',
    expect: 'registration',
  },
  {
    id: 'fr-research',
    language: 'fr',
    text: 'Peux-tu vérifier si la piscine du quartier offre encore des cours pour les tout-petits le dimanche, et à quel prix?',
    expect: 'research',
  },
  {
    id: 'fr-find',
    language: 'fr',
    text: 'Trouve-moi des activités pour un enfant de 3 ans près de chez nous cet hiver.',
    expect: 'find',
  },
  { id: 'fr-none', language: 'fr', text: "Merci, c'est noté pour mardi.", expect: 'none' },
  {
    id: 'zh-registration',
    language: 'zh',
    text: '可以帮我给孩子报名周六上午的游泳课吗？',
    expect: 'registration',
  },
  {
    id: 'zh-research',
    language: 'zh',
    text: '帮我查一下社区中心的美术班还有没有名额，多少钱？',
    expect: 'research',
  },
  {
    id: 'zh-find',
    language: 'zh',
    text: '这个周末有什么适合两岁孩子的室内活动吗？',
    expect: 'find',
  },
  { id: 'zh-none', language: 'zh', text: '好的，谢谢你！', expect: 'none' },
];

// `expect` is the exact set of problems the production mapping (judge.ts
// ackMeaningProblems) must name for the line against its window.
export const ACK_JUDGE_FIXTURES = [
  {
    id: 'en-clear',
    language: 'en',
    line: "I'm looking into it now, you'll hear back from me within five minutes.",
    latestMinutes: 5,
    requireTime: true,
    expect: [],
  },
  {
    id: 'en-sooner',
    language: 'en',
    line: "On it, you'll have it in about thirty seconds.",
    latestMinutes: 5,
    requireTime: true,
    expect: ['time_outside_window'],
  },
  {
    id: 'en-clock',
    language: 'en',
    line: "Looking now, I'll have it for you by 3:15.",
    latestMinutes: 5,
    requireTime: true,
    expect: ['time_outside_window'],
  },
  {
    id: 'en-no-time',
    language: 'en',
    line: "I'm getting the sign-up ready for you.",
    latestMinutes: 5,
    requireTime: true,
    expect: ['no_time'],
  },
  {
    id: 'en-done',
    language: 'en',
    line: "All done, she's registered. More details within five minutes.",
    latestMinutes: 5,
    requireTime: true,
    expect: ['claims_done'],
  },
  {
    id: 'en-app',
    language: 'en',
    line: 'Searching now, the options will be in the app within five minutes.',
    latestMinutes: 5,
    requireTime: true,
    expect: ['points_at_the_app'],
  },
  {
    id: 'en-stopped-clear',
    language: 'en',
    line: "Sorry, I couldn't finish that one, so it's back with you.",
    latestMinutes: null,
    requireTime: false,
    expect: [],
  },
  {
    id: 'en-stopped-more',
    language: 'en',
    line: "Sorry this is taking longer, I'll keep at it and get back to you.",
    latestMinutes: null,
    requireTime: false,
    expect: ['time_outside_window'],
  },
  {
    id: 'fr-clear',
    language: 'fr',
    line: "Je m'en occupe, tu auras ma réponse d'ici cinq minutes.",
    latestMinutes: 5,
    requireTime: true,
    expect: [],
  },
  {
    id: 'fr-sooner',
    language: 'fr',
    line: 'Je regarde ça, réponse dans quelques secondes.',
    latestMinutes: 5,
    requireTime: true,
    expect: ['time_outside_window'],
  },
  {
    id: 'fr-done',
    language: 'fr',
    line: "C'est fait, il est inscrit. Je te confirme d'ici cinq minutes.",
    latestMinutes: 5,
    requireTime: true,
    expect: ['claims_done'],
  },
  {
    id: 'zh-clear',
    language: 'zh',
    line: '我正在帮你找，五分钟内回复你。',
    latestMinutes: 5,
    requireTime: true,
    expect: [],
  },
  {
    id: 'zh-app',
    language: 'zh',
    line: '我在查，五分钟内结果会出现在应用里。',
    latestMinutes: 5,
    requireTime: true,
    expect: ['points_at_the_app'],
  },
  {
    id: 'zh-late-clear',
    language: 'zh',
    line: '抱歉比我说的慢了，我还在处理，最多再试三个小时，到时没消息就交回给你。',
    latestMinutes: 180,
    requireTime: true,
    answerMayNotCome: true,
    expect: [],
  },
  {
    id: 'zh-late-guarantee',
    language: 'zh',
    line: '抱歉比我说的慢了，三个小时内一定回复你结果。',
    latestMinutes: 180,
    requireTime: true,
    answerMayNotCome: true,
    expect: ['promises_the_answer'],
  },
  {
    id: 'en-late-clear',
    language: 'en',
    line: "This is taking longer than I said. I'll keep trying for up to three more hours, and if you haven't heard from me by then, it's back with you.",
    latestMinutes: 180,
    requireTime: true,
    answerMayNotCome: true,
    expect: [],
  },
  {
    id: 'en-late-guarantee',
    language: 'en',
    line: "Sorry, this is taking longer than I said. You'll have it within three hours.",
    latestMinutes: 180,
    requireTime: true,
    answerMayNotCome: true,
    expect: ['promises_the_answer'],
  },
  {
    id: 'fr-late-guarantee',
    language: 'fr',
    line: "Désolé, c'est plus long que prévu. Tu auras ta réponse d'ici trois heures.",
    latestMinutes: 180,
    requireTime: true,
    answerMayNotCome: true,
    expect: ['promises_the_answer'],
  },
];

// The writers' facts, as production builds them (route.ts / sweep.ts). The line is
// graded by code (compose.ts mechanicalProblems) and then by the production judge.
export const ACK_WRITER_FIXTURES = [
  {
    id: 'ack-en-registration',
    draft: { kind: 'ack', input: { task: 'registration', withinMinutes: 5, language: 'en' } },
  },
  {
    id: 'ack-fr-research',
    draft: { kind: 'ack', input: { task: 'research', withinMinutes: 5, language: 'fr' } },
  },
  {
    id: 'ack-zh-find',
    draft: { kind: 'ack', input: { task: 'find', withinMinutes: 5, language: 'zh' } },
  },
  {
    id: 'ack-null-find',
    draft: { kind: 'ack', input: { task: 'find', withinMinutes: 5, language: null } },
  },
  {
    id: 'late-en-still',
    draft: {
      kind: 'late_note',
      facts: {
        task: 'research',
        promisedMinutes: 5,
        minutesSinceAsk: 6,
        status: 'still_working',
        newWithinMinutes: 180,
        language: 'en',
      },
    },
  },
  {
    id: 'late-fr-stopped',
    draft: {
      kind: 'late_note',
      facts: {
        task: 'registration',
        promisedMinutes: 5,
        minutesSinceAsk: 7,
        status: 'stopped',
        newWithinMinutes: null,
        language: 'fr',
      },
    },
  },
  {
    id: 'late-zh-still',
    draft: {
      kind: 'late_note',
      facts: {
        task: 'find',
        promisedMinutes: 5,
        minutesSinceAsk: 6,
        status: 'still_working',
        newWithinMinutes: 180,
        language: 'zh',
      },
    },
  },
  {
    // A note held through the parent's night: the ask is hours old and the retries are over.
    id: 'late-en-morning-stopped',
    draft: {
      kind: 'late_note',
      facts: {
        task: 'find',
        promisedMinutes: 5,
        minutesSinceAsk: 520,
        status: 'stopped',
        newWithinMinutes: null,
        language: 'en',
      },
    },
  },
];

/** A read must name exactly the expected category. */
export function gradeAckRead(value, expected) {
  const task = value?.task;
  if (typeof task !== 'string') return 'read returned no task';
  if (task.trim() !== expected) return `read said ${task}, expected ${expected}`;
  return null;
}

/** A verdict's problems must be exactly the expected set: a missed problem and an extra
 * refusal of a fine line are both misses. */
export function gradeAckJudge(problems, expected) {
  const got = [...problems].sort();
  const want = [...expected].sort();
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    return `judge named [${got.join(',')}], expected [${want.join(',')}]`;
  }
  return null;
}
