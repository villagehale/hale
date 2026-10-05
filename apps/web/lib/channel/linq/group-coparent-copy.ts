/**
 * String plumbing for the Linq household group. No sentences live here.
 *
 * Every line Hale says in the group is written by the model from real facts
 * (group-voice.ts, VIL-413 / VIL-417). What is left is how composed lines are
 * joined into one bubble and how a 1:1 line written for one reader is addressed
 * to two until that line is composed for the group as well. (The evening check-in
 * no longer needs the `{name}, ` prefix: the model is handed the parent's name and
 * `vous` when the line lands in the group.)
 */

/**
 * A line for both parents. English stays. French tu/ton/ta/envoie-moi become
 * vous/votre/envoyez-moi. A `{name}, ` line is not passed through here.
 */
export function groupBothReaderFrench(text: string): string {
  return text
    .replaceAll('Tu veux', 'Vous voulez')
    .replaceAll('tu veux', 'vous voulez')
    .replaceAll('Envoie-moi', 'Envoyez-moi')
    .replaceAll('envoie-moi', 'envoyez-moi')
    .replaceAll(/\bTon\b/g, 'Votre')
    .replaceAll(/\bTa\b/g, 'Votre')
    .replaceAll(/\bton\b/g, 'votre')
    .replaceAll(/\bta\b/g, 'votre');
}

/** The weekly bubble, plus up to three how-it-went lines. One text, not a second send. */
export function absorbHowItWentLines(weekly: string, lines: readonly string[]): string {
  const extra = lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 3);
  if (extra.length === 0) return weekly;
  return `${weekly.trimEnd()}\n${extra.join('\n')}`;
}
