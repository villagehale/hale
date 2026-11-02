import type { FamilyStage } from '@hale/types';

/**
 * Village intros — the stage noun handed to the composers as a FACT. Every line Hale
 * sends about an introduction is model-written (voice.ts, group-voice.ts, and said-line
 * `intro_yes` / `intro_reply` in reply.ts); the fixed acknowledgements and the soft close
 * that lived here were removed in VIL-450.
 *
 * THE TWO ASKS LEFT THIS FILE ON 2026-08-13 (see voice.ts). They were the last two
 * strings on this surface that handed a parent a keyword to recite, and reading them back
 * to back — "Reply YES INTROS or NO INTROS." then, hours later, "Reply YES INTRO or NO
 * INTRO." — is what made the founder call the whole feature inhuman. They are composed
 * now, under pinned meanings and mechanical refusals, and the parent's answer is read
 * however they phrase it.
 *
 * THE PRIVACY RULE IS STRUCTURAL WHEREVER THE WORDS COME FROM. It never lived in this
 * file's fixedness; it lives in what the renderers are HANDED. The composed card's
 * request type carries the same three facts `coarseCard` took — a stage WORD (a band, not
 * a child), the recipient's OWN child through the teen gate, and a civic activity title —
 * and there is no parameter on either side that could name the other household.
 */

/**
 * How Hale refers to a child of a given stage when it is talking about SOMEBODY ELSE'S
 * child — the one and only counterpart fact a coarse card carries.
 *
 * These are nouns, deliberately, and different from the dashboard's `STAGE_LABEL`
 * adjectives: "a Hale family near you has a preschool" is not English, and a card a
 * parent has to re-read is a card that reads as spam. `Record<FamilyStage, string>` so
 * a new stage cannot ship without someone choosing its word.
 *
 * 'teenager' has a word here even though v1 never matches on the teen band (see
 * `eligibleAnchorChildren`): the map must stay total, and the day teen intros earn a
 * consent model of their own, the word should not be invented in a hurry.
 */
const STAGE_WORD: Record<FamilyStage, string> = {
  newborn: 'baby',
  toddler: 'toddler',
  preschool: 'preschooler',
  child: 'kid',
  teenager: 'teen',
};

export function stageWord(stage: FamilyStage): string {
  return STAGE_WORD[stage];
}
