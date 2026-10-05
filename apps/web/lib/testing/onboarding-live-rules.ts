/**
 * The rule checks the live onboarding replay runs over every outbound bubble
 * (lib/channel/intake/onboarding-live.test.ts). Pure, so the rules themselves are unit-tested
 * without a model; the replay prints each bubble verbatim and then lists the
 * rules it broke.
 */

import { MAX_PROSE_CHARS } from '~/lib/channel/intake/friend-voice';
import { LINQ_GROUP_TRIGGER_PHRASE } from '~/lib/channel/linq/group';

export interface LiveTurn {
  /** What the parent sent, or a connector receipt label like `[gmail connected]`. */
  inbound: string;
  /** Every bubble Hale sent on that turn, in order. */
  bubbles: string[];
  /** Wall-clock for the turn, when measured. */
  ms?: number;
  /** The router's outcome. `handed_off` means the coach answers from the worker. */
  outcome?: string;
}

export interface LiveReplay {
  turns: LiveTurn[];
  /** The parent's row after the walk. */
  parentName: string | null;
  /** The kids as stored. */
  kidNames: string[];
  /** Titles of the reminder events written on the schedule step. */
  scheduledTitles: string[];
}

export interface LiveExpectations {
  /** The map lines code supplied, in order. */
  mapLines: readonly string[];
  /** The parent's name in the script. */
  parentName: string;
  /** Titles or subjects in the stub source that are about the kids. */
  kidItems: readonly string[];
  /** Titles or subjects in the stub source that are the parent's own. */
  parentItems: readonly string[];
  /** Words the schedule step must have written, and words it must not. */
  scheduledMust: readonly RegExp[];
  scheduledMustNot: readonly RegExp[];
}

const BOOKING_CLAIM = /\b(booked|enrolled|signed[- ]up|registered)\b/i;
const FALSE_PRIVACY =
  /never (?:see|read|look at)|(?:won't|will not|don't|do not) (?:see|read|look at) (?:your )?(?:work|personal|other|private)|stays? between you|only (?:see|read) (?:the )?kids?['’]? (?:stuff|mail|email)/i;
const STOP_WORDING = /\bSTOP\b|unsubscribe/;
const WHICH_ONE = /which (?:one|of these|ones?)\b/i;
const NUMBERED = /^\d+\.\s/m;
const LINK = /https?:\/\/\S+/;

function isLinkBubble(bubble: string): boolean {
  return LINK.test(bubble);
}

function isMapBubble(bubble: string): boolean {
  return NUMBERED.test(bubble);
}

/** The prose of a bubble: no URL line, no numbered lines, no join trailer. */
/** The co-parent join lines code puts under a yes: Hale's number and the phrase. */
const JOIN_LINE = new RegExp(
  `^(?:\\+?[\\d\\s().-]{10,}|${Object.values(LINQ_GROUP_TRIGGER_PHRASE).join('|')})$`,
  'u',
);

function proseOf(bubble: string): string {
  return bubble
    .split('\n')
    .filter((line) => !LINK.test(line) && !/^\d+\.\s/.test(line) && !JOIN_LINE.test(line.trim()))
    .join('\n')
    .trim();
}

/** Words too common to tell one title from another. */
const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'your',
  'you',
  'this',
  'that',
  'from',
  'next',
  'week',
  'day',
  'ready',
  'hold',
  'about',
  'time',
  'at',
  'on',
  'in',
  'of',
  'to',
]);

/** The content words of a title or subject, with any " - sender" tail dropped. */
function wordsOf(item: string): string[] {
  const core = item
    .toLowerCase()
    .replace(/\s+-\s+.*$/u, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .trim();
  return core.split(/\s+/).filter((word) => word.length > 2 && !STOPWORDS.has(word));
}

/** A kid item counts as mentioned when two of its words appear, or all of them when it is short. */
function mentionsKidItem(text: string, item: string): boolean {
  const words = wordsOf(item);
  if (words.length === 0) return false;
  const lower = text.toLowerCase();
  const hits = words.filter((word) => lower.includes(word));
  return words.length <= 2 ? hits.length === words.length : hits.length >= 2;
}

/**
 * A parent item counts as named only through words the kid items do not share,
 * anchored on its longest such word: "Mia" in "1:1 with Mia Chen" proves nothing
 * when the kid is Mia; "Chen" and "Product" together do.
 */
function namesParentItem(text: string, item: string, kidItems: readonly string[]): boolean {
  const shared = new Set(kidItems.flatMap(wordsOf));
  const distinctive = wordsOf(item).filter((word) => !shared.has(word));
  if (distinctive.length === 0) return false;
  const anchor = distinctive.reduce((best, word) => (word.length > best.length ? word : best));
  const lower = text.toLowerCase();
  if (!lower.includes(anchor)) return false;
  const hits = distinctive.filter((word) => lower.includes(word));
  return hits.length >= Math.min(2, distinctive.length);
}

/** Every rule the replay checks, as short sentences a founder can read. */
export function liveViolations(replay: LiveReplay, expect: LiveExpectations): string[] {
  const out: string[] = [];
  const all = replay.turns.flatMap((turn) => turn.bubbles);
  const parentTurns = replay.turns.filter((turn) => !turn.inbound.startsWith('['));

  for (const turn of parentTurns) {
    if (turn.bubbles.length === 0 && turn.outcome !== 'handed_off') {
      out.push(`unanswered: "${turn.inbound}"`);
    }
  }

  // The map: its own bubbles, every real line, no question, no which-one.
  const mapTurn = replay.turns.find((turn) => turn.bubbles.some(isMapBubble));
  if (!mapTurn) {
    out.push('map never sent');
  } else {
    const mapBubbles = mapTurn.bubbles.filter(isMapBubble);
    const firstMap = mapTurn.bubbles.findIndex(isMapBubble);
    const mapText = [...mapTurn.bubbles.slice(0, firstMap), ...mapBubbles].join('\n');
    for (const line of expect.mapLines) {
      if (!mapText.includes(line)) out.push(`map line missing: "${line}"`);
    }
    if (mapText.includes('?')) out.push('map carries a question mark');
    if (WHICH_ONE.test(mapText)) out.push('map asks which one');
    const after = mapTurn.bubbles.slice(firstMap + mapBubbles.length);
    const nameAsk = after.find((bubble) => /\?/.test(bubble));
    if (!nameAsk) out.push('name not asked as its own message after the map');
    else if (isMapBubble(nameAsk)) out.push('name ask shares a bubble with the map');
  }

  // The parent's name: stored as given, never a kid's, never asked twice after it was given.
  if (replay.parentName !== expect.parentName) {
    out.push(
      `parent name stored as ${JSON.stringify(replay.parentName)}, expected "${expect.parentName}"`,
    );
  }
  if (replay.parentName && replay.kidNames.some((kid) => kid === replay.parentName)) {
    out.push(`a kid's name was stored as the parent's: ${replay.parentName}`);
  }
  const nameGivenAt = parentTurns.findIndex((turn) => turn.inbound.trim() === expect.parentName);
  if (nameGivenAt >= 0) {
    const later = parentTurns.slice(nameGivenAt + 1).flatMap((turn) => turn.bubbles);
    if (
      later.some((bubble) =>
        /what (?:should|do) i call you|what'?s your name|your name\?/i.test(bubble),
      )
    ) {
      out.push('name asked again after it was given');
    }
  }

  // Wow moments: kid items only, and sent.
  for (const label of ['[gmail connected]', '[calendar connected]'] as const) {
    const receipt = replay.turns.find((turn) => turn.inbound === label);
    if (!receipt) continue;
    const text = receipt.bubbles.join('\n');
    if (receipt.bubbles.length === 0) {
      out.push(`${label}: nothing sent (receipt and next step both missing)`);
      continue;
    }
    for (const item of expect.parentItems) {
      if (namesParentItem(text, item, expect.kidItems))
        out.push(`${label}: names a parent item: "${item}"`);
    }
    if (!expect.kidItems.some((item) => mentionsKidItem(text, item))) {
      out.push(`${label}: no kid item mentioned (wow skipped)`);
    }
  }

  // Nothing is connected until its receipt: no "Gmail is set" before the tap.
  const gmailAt = replay.turns.findIndex((turn) => turn.inbound === '[gmail connected]');
  const beforeGmail = gmailAt < 0 ? replay.turns : replay.turns.slice(0, gmailAt);
  for (const turn of beforeGmail) {
    for (const bubble of turn.bubbles) {
      if (
        /\b(?:gmail|inbox|calendar)\b[^.?!]{0,20}\b(?:is|['’]s) (?:now )?(?:set|connected|linked|done)\b/i.test(
          bubble,
        )
      ) {
        out.push(`connected claimed before the tap: "${bubble.slice(0, 80)}"`);
      }
    }
  }

  // The schedule ask follows the calendar wow; the co-parent ask comes once.
  const calendarReceipt = replay.turns.find((turn) => turn.inbound === '[calendar connected]');
  if (calendarReceipt && calendarReceipt.bubbles.length > 0) {
    if (!calendarReceipt.bubbles.some((bubble) => proseOf(bubble).includes('?'))) {
      out.push('schedule ask not sent after the calendar wow');
    }
  }
  const coparentAsks = all.filter(
    (bubble) =>
      proseOf(bubble).includes('?') &&
      /\b(?:group (?:chat|text)|other parent|co-?parent)\b/i.test(proseOf(bubble)),
  );
  if (coparentAsks.length > 1) out.push(`co-parent asked ${coparentAsks.length} times`);
  if (expect.parentName) {
    const asParent = new RegExp(`\\bI['’]?m ${expect.parentName}\\b`, 'i');
    if (all.some((bubble) => asParent.test(bubble))) {
      out.push(`Hale called itself ${expect.parentName}`);
    }
  }

  // Links: a card rides only the ask about its own connector. The prose a link
  // sits under is its own bubble's, or the bubble just before it when the link
  // went out alone.
  for (const turn of replay.turns) {
    turn.bubbles.forEach((bubble, index) => {
      if (!isLinkBubble(bubble)) return;
      const own = proseOf(bubble);
      const prose = own.length > 0 ? own : proseOf(turn.bubbles[index - 1] ?? '');
      if (/to=gmail/.test(bubble)) {
        if (!/gmail|email|inbox|mail/i.test(prose)) {
          out.push(`gmail link under prose about something else: "${prose.slice(0, 80)}"`);
        }
        if (/\?/.test(prose) && /call you|your name/i.test(prose)) {
          out.push('gmail link under a name question');
        }
      }
      if (/to=gcal/.test(bubble)) {
        if (!/calendar|calendrier/i.test(prose)) {
          out.push(`calendar link under prose about something else: "${prose.slice(0, 80)}"`);
        }
        if (/gmail|inbox/i.test(prose)) out.push('calendar link under a Gmail ask');
      }
    });
  }
  const gmailLinks = all.filter((bubble) => /to=gmail/.test(bubble)).length;
  const gcalLinks = all.filter((bubble) => /to=gcal/.test(bubble)).length;
  if (gmailLinks === 0) out.push('gmail link never sent');
  if (gcalLinks === 0) out.push('calendar link never sent');
  if (gmailLinks > 1) out.push(`gmail link sent ${gmailLinks} times`);
  if (gcalLinks > 1) out.push(`calendar link sent ${gcalLinks} times`);

  // Claims and wording.
  for (const bubble of all) {
    const prose = proseOf(bubble);
    if (BOOKING_CLAIM.test(prose)) out.push(`booking claim: "${prose.slice(0, 100)}"`);
    if (FALSE_PRIVACY.test(prose)) out.push(`false privacy claim: "${prose.slice(0, 100)}"`);
    if (STOP_WORDING.test(prose)) out.push(`STOP wording: "${prose.slice(0, 100)}"`);
    if (prose.length > MAX_PROSE_CHARS && !isMapBubble(bubble)) {
      out.push(
        `bubble over ${MAX_PROSE_CHARS} chars (${prose.length}): "${prose.slice(0, 60)}..."`,
      );
    }
  }

  // Who is this: the company is named.
  const identity = parentTurns.find((turn) => /who is this/i.test(turn.inbound));
  if (identity && !/village\s?hale/i.test(identity.bubbles.join('\n'))) {
    out.push('who-is-this answered without naming the company');
  }

  // The schedule: the right lines for the right kids, nothing else.
  for (const must of expect.scheduledMust) {
    if (!replay.scheduledTitles.some((title) => must.test(title))) {
      out.push(`schedule missing ${must}`);
    }
  }
  for (const not of expect.scheduledMustNot) {
    if (replay.scheduledTitles.some((title) => not.test(title))) {
      out.push(`schedule wrote the wrong line ${not}`);
    }
  }
  const uniqueTitles = new Set(replay.scheduledTitles);
  if (replay.scheduledTitles.length > uniqueTitles.size * 8) {
    out.push('schedule wrote the same line more than weekly');
  }

  return out;
}

/** p50 of the measured turn latencies, in ms. Null when nothing was measured. */
export function p50TurnMs(turns: readonly LiveTurn[]): number | null {
  const measured = turns
    .flatMap((turn) => (turn.ms == null ? [] : [turn.ms]))
    .sort((a, b) => a - b);
  if (measured.length === 0) return null;
  return measured[Math.floor(measured.length / 2)] ?? null;
}

export { isLinkBubble, isMapBubble, proseOf };
