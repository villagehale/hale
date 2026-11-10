/**
 * Find-turn reader fixtures (VIL-567).
 *
 * Each case has one right `intent`. Scored through the same parse production uses
 * (`toFindTurnReading`). The texts are parent inbounds in several languages; there is
 * no word list to match. Not named run-*.mjs so the Monday sweep does not pick this
 * suite up before recordings exist.
 */
export const FIND_TURN_FIXTURES = [
  {
    id: 'en-weekend',
    text: "what's on this weekend",
    transcript: [],
    expect: 'find',
  },
  {
    id: 'en-find-something',
    text: 'find me something to do',
    transcript: [],
    expect: 'find',
  },
  {
    id: 'en-calendar-move',
    text: 'move swim to tuesday',
    transcript: [],
    expect: 'not_find',
  },
  {
    id: 'en-calendar-read',
    text: "what's on the calendar today",
    transcript: [],
    expect: 'not_find',
  },
  {
    id: 'follow-up-find',
    text: 'the library one',
    transcript: [{ role: 'user', content: "what's on this weekend" }],
    expect: 'find',
  },
  {
    id: 'follow-up-edit',
    text: 'move swim to tuesday',
    transcript: [{ role: 'user', content: "what's on this weekend" }],
    expect: 'not_find',
  },
  {
    id: 'en-find-then-move',
    text: 'find me the swim and move it to 4',
    transcript: [],
    expect: 'not_find',
  },
  {
    id: 'fr-find',
    text: "trouve-moi quelque chose à faire aujourd'hui",
    transcript: [],
    expect: 'find',
  },
  {
    id: 'zh-find',
    text: '帮我找找这周末附近有什么活动',
    transcript: [],
    expect: 'find',
  },
  {
    id: 'fr-calendar',
    text: 'déplace la natation à mardi',
    transcript: [],
    expect: 'not_find',
  },
];
