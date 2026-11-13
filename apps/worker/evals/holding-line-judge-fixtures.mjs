// VIL-540 corpus for the holding-line meaning judge. Lines are eval inputs, never
// a line Hale sends, and never a fallback if the judge misses. Nothing here is
// copied into the skill: the skill judges meaning and does not list phrases.

export const HOLDING_LINE_JUDGE_FIXTURES = [
  {
    id: 'en-clear',
    language: 'en',
    line: "I'm on it. Your answer is coming.",
    expect: 'clear',
  },
  {
    id: 'en-time',
    language: 'en',
    line: "I'm on it and will have it shortly.",
    expect: 'promised_a_time',
  },
  {
    id: 'en-as-soon-as',
    language: 'en',
    line: "Still on it. Your answer is coming, I'll send it here as soon as I have it.",
    expect: 'promised_a_time',
  },
  {
    id: 'en-app',
    language: 'en',
    line: "I'm on it. Your week is in the app.",
    expect: 'points_at_an_app',
  },
  {
    id: 'en-website',
    language: 'en',
    line: "I'm on it. The details are on the website.",
    expect: 'points_at_an_app',
  },
  {
    id: 'fr-clear',
    language: 'fr',
    line: "J'y travaille, la réponse arrive.",
    expect: 'clear',
  },
  {
    id: 'fr-time',
    language: 'fr',
    line: "Je m'en occupe, ce sera bientôt prêt.",
    expect: 'promised_a_time',
  },
  {
    id: 'fr-app',
    language: 'fr',
    line: "Je m'en occupe. C'est dans l'application.",
    expect: 'points_at_an_app',
  },
  {
    id: 'zh-clear',
    language: 'zh',
    line: '我在处理，答复会来。',
    expect: 'clear',
  },
  {
    id: 'zh-time',
    language: 'zh',
    line: '我马上就回你。',
    expect: 'promised_a_time',
  },
  {
    id: 'zh-app',
    language: 'zh',
    line: '我在处理，你去应用里看。',
    expect: 'points_at_an_app',
  },
  {
    id: 'en-both',
    language: 'en',
    line: 'I will have it shortly, and the rest is on the website.',
    expect: 'both',
  },
  {
    id: 'zh-website',
    language: 'zh',
    line: '详情在网站上。',
    expect: 'points_at_an_app',
  },
];

/** Same JSON the production user message must produce. The dry eval pins them. */
export function judgeUserMessage(line) {
  return JSON.stringify({ line });
}

/**
 * A single-issue fixture must match on both axes: a time-only line that also
 * points at an app (or the reverse) is a miss, not a pass.
 */
export function gradeHoldingLineJudge(value, expected) {
  const time = value?.promises_a_time;
  const place = value?.points_at_an_app;
  if (time !== 'yes' && time !== 'no') return 'judge returned no time verdict';
  if (place !== 'yes' && place !== 'no') return 'judge returned no place verdict';
  if (expected === 'clear') {
    if (time !== 'no' || place !== 'no') {
      return `judge refused a clear line (time=${time} place=${place})`;
    }
    return null;
  }
  if (expected === 'promised_a_time') {
    if (time !== 'yes') return 'judge missed a promised time';
    if (place !== 'no') return `judge also refused a place on a time-only line (place=${place})`;
    return null;
  }
  if (expected === 'points_at_an_app') {
    if (place !== 'yes') return 'judge missed an app or a website';
    if (time !== 'no') return `judge also refused a time on a place-only line (time=${time})`;
    return null;
  }
  if (expected === 'both') {
    if (time !== 'yes' || place !== 'yes') {
      return `judge missed a time or a place (time=${time} place=${place})`;
    }
    return null;
  }
  return `unknown expect ${expected}`;
}
