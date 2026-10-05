/**
 * String plumbing for the Linq household group. No sentences live here.
 *
 * Every line Hale says in the group is written by the model from real facts
 * (group-voice.ts, VIL-413 / VIL-417). What is left is how composed lines are
 * joined into one bubble. A line that lands in the group is composed FOR the group
 * (the model is handed `vous` and both readers); there is no tu-to-vous rewrite of
 * a 1:1 line any more, because a word swap is a template by another name.
 */

/** The weekly bubble, plus up to three how-it-went lines. One text, not a second send. */
export function absorbHowItWentLines(weekly: string, lines: readonly string[]): string {
  const extra = lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 3);
  if (extra.length === 0) return weekly;
  return `${weekly.trimEnd()}\n${extra.join('\n')}`;
}
