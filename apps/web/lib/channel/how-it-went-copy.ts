/**
 * VIL-366 · Design-locked EN ask (byte-stable aside from the activity slot).
 *
 * `How did {activity} go? One line is plenty.`
 *
 * FR TODO: the ticket says a French twin is locked, but it was not in the repo
 * or in the Linear comments and design docs searched on 2026-09-23. Do not invent one.
 * Ship EN only until that twin is pasted in from Design.
 */
export function howItWentAsk(activity: string): string {
  return `How did ${activity} go? One line is plenty.`;
}
