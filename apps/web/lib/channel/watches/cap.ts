/**
 * Concurrent live-watch cap — facts for the model, never parent copy.
 *
 * A watch is a standing promise. The cap is checked before the verb tells the
 * model it armed one, so a parent is not told Hale is watching a ninth class
 * when eight is the household's limit. The model composes the reply from the
 * two numbers; this string names them and nothing else (no plan, no price).
 *
 * These are tool-result facts, the same class as the other `watch_for_opening`
 * refusals. They are not a Langfuse prompt. Channel tools do not load prompts
 * by name.
 */

export function liveWatchCapRefusal(
  live: number,
  cap: number | null,
  alreadyWatching = false,
): string | null {
  if (alreadyWatching || cap === null || live < cap) return null;
  return `This household is already watching ${live} classes, which is their cap of ${cap}.`;
}
