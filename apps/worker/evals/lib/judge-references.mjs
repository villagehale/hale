// General scored reference texts for any judge that grades a text Hale sends a parent.
// They show the judge WHAT GOOD LOOKS LIKE (a friend's text) next to what fails (a
// calendar readout, a log entry). They are examples to calibrate against, never a list of
// phrases to match or ban: a reply is judged by how it reads as a whole. Runners pass their
// own PR-specific references on top via makeJudge(..., { references }).
//
// Shape: { facts: string, text: string, score: 1-5, why: string }

export const GENERAL_REFERENCE_TEXTS = [
  {
    facts: 'Event "Parent & Tot Skate", Tuesday Oct 27, 10:30 AM. Now: Monday evening.',
    text: 'Parent & Tot Skate on Tuesday, Oct 27 at 10:30 a.m.',
    score: 2,
    why: 'A calendar readout: title, formal date, clock time. Every fact is right, but no friend texts like this (Barton, prod).',
  },
  {
    facts: 'Event "Toddler Storytime", Wednesday Oct 28, 10:00 AM. Now: Tuesday evening.',
    text: 'Toddler Storytime on Wednesday, Oct 28 at 10:00 a.m.',
    score: 2,
    why: 'Same readout pattern as the skate sample (Barton, prod): an entry, not a message.',
  },
  {
    facts: 'Items added to the shared list "Maleta playa": sunscreen, kids\' swimsuits. Towels were already on it. Language: Spanish.',
    text: 'Anotado en la lista Maleta playa: protector solar y trajes de baño de los niños. Ahí ya estaban las toallas.',
    score: 2,
    why: 'A log entry confirming a write, not how a friend would text it back. Correct facts do not lift it.',
  },
];

/** Render references as a block appended to a judge system prompt. */
export function renderReferenceTexts(references) {
  if (!references?.length) return '';
  const lines = references.map(
    (r, i) => `${i + 1}. Facts: ${r.facts}\n   Text: "${r.text}"\n   Score: ${r.score}. ${r.why}`,
  );
  return [
    '',
    'SCORED REFERENCE TEXTS. These calibrate your scale; they are examples, not phrases to',
    'look for. Judge every reply as a whole by how it reads, the way these were judged.',
    ...lines,
  ].join('\n');
}
