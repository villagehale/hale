/**
 * Quick-log detection, REPLICATED from apps/web/lib/coach/action-intent.ts
 * (QUICK_LOG_EPISODE_RULES + parseQuickLog). The native bundle can't import
 * server route code, so the regex rules are hand-copied — the same discipline as
 * api-types.ts. Keep in sync when the web rules change.
 *
 * Pure, no I/O, no LLM (rule #2 untouched): a closed set of regexes maps a
 * parent's OWN report ("baby had a 4oz bottle") to a quick_log episode. A miss
 * returns null (no card); a false positive only ever shows a confirm card the
 * parent taps or dismisses — bounded cost, and it's their own factual household
 * data, so there's no approval gate (Regime A).
 *
 * Beyond the web parse (episode / time / child / milestone) this also lifts the
 * numeric amount the web leaves to the form — amountMl for a feed, durationMin
 * for a nap — so the mobile confirm card is actionable in a single tap.
 */

export type QuickLogMatch =
  | { kind: 'feed'; amountMl?: number; timeHint?: string; childName?: string }
  | { kind: 'nap'; durationMin?: number; timeHint?: string; childName?: string }
  | { kind: 'milestone'; milestone?: string; timeHint?: string; childName?: string };

type Episode = QuickLogMatch['kind'];

/** 1 fluid ounce ≈ 30 ml — the rounded infant-feeding convention (4 oz → 120 ml). */
const ML_PER_OZ = 30;

/** Up to two words between the article and the episode noun, so an inline amount
 * ("a 4oz bottle", "a 45 minute nap") still matches. Widens the web rule, which
 * put the noun immediately after "a" and so missed amount phrasings. */
const QTY = '(?:\\w+\\s+){0,2}';

/** episode → the phrasings that name a logged observation. Order matters: the
 * first matching episode wins, matching the web rule set (feed before nap). */
const EPISODE_RULES: readonly { episode: Episode; patterns: readonly RegExp[] }[] = [
  {
    episode: 'feed',
    patterns: [
      new RegExp(
        `\\b(?:had|took|gave|log(?:ged)?)\\s+(?:a\\s+)?${QTY}(?:feed|bottle|nurse|nursing)\\b`,
        'i',
      ),
    ],
  },
  {
    episode: 'nap',
    patterns: [
      new RegExp(`\\b(?:had|took|went\\s+down\\s+for|log(?:ged)?)\\s+(?:a\\s+)?${QTY}nap\\b`, 'i'),
      /\bnapped\b/i,
    ],
  },
  {
    episode: 'milestone',
    patterns: [/\bhit\s+a\s+milestone\b/i, /\b(?:reached|log(?:ged)?)\s+(?:a\s+)?milestone\b/i],
  },
];

/** A leading "<Name> had/took/hit …" — a capitalised token that reads as the child. */
const CHILD_NAME_RE = /^\s*([A-Z][a-z]+)\b/;
/** A clock or coarse time phrase to pre-fill "when". Best-effort — the parent edits. */
const TIME_HINT_RE =
  /\b(\d{1,2}(?::\d{2})?\s*(?:am|pm))\b|\b(this (?:morning|afternoon|evening)|last night|tonight|earlier today|yesterday)\b/i;
/** The text after "milestone:" — what the child did. */
const MILESTONE_TEXT_RE = /milestone:\s*(.+)$/i;

/** A feed amount: "4oz" / "4 oz" (converted) or "90ml" / "90 ml" (used as-is). */
const FEED_AMOUNT_RE = /\b(\d+(?:\.\d+)?)\s*(oz|ml)\b/i;
/** A nap length in minutes: "45 minute", "45 min", "45m". Hours aren't parsed —
 * the parent edits the card if the message doesn't give minutes. */
const NAP_MINUTES_RE = /\b(\d+)\s*(?:minute|minutes|min|mins|m)\b/i;

function commonHints(text: string): { timeHint?: string; childName?: string } {
  const out: { timeHint?: string; childName?: string } = {};
  const time = text.match(TIME_HINT_RE);
  if (time) out.timeHint = (time[1] ?? time[2])?.trim();
  const name = text.match(CHILD_NAME_RE);
  if (name) out.childName = name[1];
  return out;
}

function feedAmountMl(text: string): number | undefined {
  const m = text.match(FEED_AMOUNT_RE);
  if (!m) return undefined;
  const value = Number(m[1]);
  return m[2].toLowerCase() === 'oz' ? Math.round(value * ML_PER_OZ) : value;
}

function napDurationMin(text: string): number | undefined {
  const m = text.match(NAP_MINUTES_RE);
  return m ? Number(m[1]) : undefined;
}

/**
 * Detect the quick-log episode a parent's message reports, or null for an
 * ordinary message (the common case). At most one episode — the first match in
 * rule order wins, so "had a bottle before her nap" logs the feed.
 */
export function detectQuickLog(text: string): QuickLogMatch | null {
  const rule = EPISODE_RULES.find((r) => r.patterns.some((p) => p.test(text)));
  if (!rule) return null;

  const hints = commonHints(text);
  if (rule.episode === 'feed') {
    const amountMl = feedAmountMl(text);
    return { kind: 'feed', ...(amountMl !== undefined ? { amountMl } : {}), ...hints };
  }
  if (rule.episode === 'nap') {
    const durationMin = napDurationMin(text);
    return { kind: 'nap', ...(durationMin !== undefined ? { durationMin } : {}), ...hints };
  }
  const milestone = text.match(MILESTONE_TEXT_RE)?.[1]?.trim();
  return { kind: 'milestone', ...(milestone ? { milestone } : {}), ...hints };
}
