/**
 * VIL-293 · THE RECONCILIATION PRIMITIVE, half one — what did this message CLAIM?
 *
 * THE INVARIANT: a sentence that asserts Hale has a row must be reconcilable against
 * that row before it reaches a transport. The other half (reconcile.ts) does the
 * reconciling; this half decides what there is to reconcile, and it does it with
 * regexes and nothing else.
 *
 * DETERMINISTIC ON EVERY PATH, and that is a requirement rather than a preference. The
 * inline coach lane runs this on the string the model just wrote, in front of a parent
 * holding a phone: a model call here would double the turn's latency and would make the
 * gate that catches a hallucinated promise itself capable of hallucinating. So it is
 * text in, spans out, no client, no await.
 *
 * FOUR CLAIM FAMILIES, and the taxonomy is closed on purpose (see {@link ClaimKind}).
 * "I'll let you know once it's done" is not in it, and that is not an oversight: every
 * family here names a question the database can answer, plus the one family whose answer
 * is always no. A wider net would refuse the deterministic templates that have said
 * "I'll text you when something needs doing" since launch — sentences that are true
 * because the machine underneath them is true, with no row to point at.
 *
 * WHAT IT COST TO NOT HAVE THIS (the 2026-08-21/22 audit):
 *   · "I'm watching that morning and I'll text you before it goes live" — nothing was
 *     watching. The registration ladder is a sweep; a coach turn cannot arm it, and no
 *     row existed to say the parent had been told otherwise.
 *   · "I'm checking details on 5 finds nearby - I'll text you the good ones" — the
 *     promise tool was never called, so the 24h sweep could not select the family.
 *   · "I'll cut the one sec messages and just answer" — a promise about Hale's own
 *     wiring, which no ledger can hold and no code path can keep.
 *   · "your well-baby visit is booked" — with nothing on the family's calendar.
 */

/**
 * The four things a message can claim that this primitive knows how to check.
 *
 * Each maps to exactly one question in reconcile.ts, and three of the four can be
 * answered yes. `self_referential` is the one that never can — a promise about how Hale
 * behaves has no table, which is precisely why a model is free to invent it.
 */
export type ClaimKind =
  /** "I'm watching that morning and I'll text you before it goes live." */
  | 'registration_watch'
  /** "I'll check the details and text you the good ones." */
  | 'activity_followup'
  /** "Your well-baby visit is booked." — an assertion that a placement exists. */
  | 'scheduled_event'
  /** "I'll cut the one sec messages and just answer." — a promise about Hale itself. */
  | 'self_referential';

export interface StateClaim {
  /**
   * The sentence exactly as it appears in the body. It is the SPAN, not a paraphrase,
   * because a lane that cannot re-ask has one honest move left: drop the sentence and
   * send what survives. That only works if the string can be found again.
   */
  sentence: string;
  kind: ClaimKind;
  /**
   * The claim's content words, lowercased — what a `scheduled_event` is matched on.
   * Empty for the promise families, which are matched by KIND against the ledger and
   * never by their words.
   */
  words: readonly string[];
}

/**
 * Sentence-ish. SMS bodies are two segments of plain ASCII, so terminal punctuation and
 * newlines are the whole grammar; a dash-joined clause stays with its sentence because
 * "I'm watching that morning and I'll text you before it goes live" is one claim.
 *
 * A CAPITAL LETTER IS REQUIRED after the break, and that is not tidiness. Every
 * registration leg Hale sends contains "7:00 a.m.", and a naive split on `.` shatters it
 * into fragments — which loses the claim (neither half holds both the verb and the
 * subject) AND loses the span a lane needs to drop a sentence it cannot back.
 */
function sentencesOf(body: string): string[] {
  return body
    .split(/(?<=[.!?])\s+(?=[A-Z(])|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

/** Hale is about to do something: "I'll text you", "I will send", "I'm going to check". */
const FIRST_PERSON_FUTURE = /\bi(?:'ll|\s+will|'m\s+going\s+to|\s+am\s+going\s+to)\b/i;
/** Hale says it is doing something RIGHT NOW: "I'm watching", "I'm checking". A claim
 * about live state, and the harder half of the 2026-08-21 pair — a sweep that is not
 * running is not made to run by the present tense. */
const FIRST_PERSON_PROGRESSIVE = /\bi'm\s+\w+ing\b/i;

/** The sentence disowns the promise it contains. Checked before anything else, because
 * "I can't watch a site and ping you" is the TRUE version of the claim above it. */
const FIRST_PERSON_NEGATED =
  /\bi\s*(?:'m not|am not|can'?t|cannot|won'?t|will not|don'?t|do not|couldn'?t)\b/i;

/** Somebody else's promise, reported. "You said you'll register her Monday" is the
 * parent's commitment, and Hale repeating it owes nothing. */
const REPORTED_SPEECH =
  /\b(?:you|they|she|he)\s+(?:said|told|mentioned|wrote|promised)\b|\byour\s+(?:note|text|message|last\s+text)\s+(?:said|says)\b/i;

/** The SUBJECT of the assertion is an absence: "Nothing's booked until you call the
 * clinic" is the drafted-action receipt, and it is the opposite of a booking claim. */
const NEGATIVE_SUBJECT = /\b(?:nothing|none|nobody|neither|no)\b/i;

/** Hale will TELL the parent, or is watching so it can. */
const NOTIFY_VERB =
  /\b(?:watch|watching|keep\s+an\s+eye|monitor|monitoring|text|texting|message|messaging|ping|let\s+you\s+know|flag|alert|remind|tell\s+you|send)\b/i;
/** The registration morning, named. Deliberately NOT "window" or "spot": the ladder's
 * own check-in reply says "I'll flag the next Halton Hills window early", and that
 * sentence is about a cycle nobody has published yet. */
const REGISTRATION_SUBJECT =
  /\b(?:registration|register|registering|sign[-\s]?ups?|signing\s+up|opens?|opening|goes?\s+live|go\s+live|doors\s+open)\b/i;

/** Hale will go and look, or come back with what it found. */
const RETURN_VERB =
  /\b(?:come\s+back|circle\s+back|get\s+back|follow\s+up|check|checking|look|looking|find|finding|dig|digging|text|texting|message|send|let\s+you\s+know)\b/i;
/** Something to look FOR. "schedule" is absent on purpose — the caregiver welcome says
 * "I'll text you the week's schedule", and that is the weekly loop, not a search.
 *
 * THE SECOND GROUP IS WHAT HALE COMPOSES rather than what Hale finds, and it was missing
 * until VIL-313. This list was written off an SMS corpus, where a coming-back promise is
 * always about a FIND; a CALL produced the other half of the shape on its first real
 * outing — "Once I've got the details locked down I'll text you" and "I'll send you the
 * Three-Day Potty breakdown after this call" (founder call CA170c1fb0, 03:11-03:14Z).
 * Both are Hale promising to send a thing it will put together, both went unmatched,
 * both left no row, and no text followed either.
 *
 * Nothing shipped says these words. Checked against every deterministic template on the
 * wire — the caregiver welcome's "the week's schedule", the intros' "at the next good
 * match", the ladder's "your plan the evening before", START_ACK — and none of them
 * names a deliverable. "guide" and "plan" are deliberately absent: "guidance" is what
 * the tool-ack line says out loud, and "plan" is the registration ladder's own promise,
 * which is a different ledger kind. */
const ACTIVITY_SUBJECT =
  /\b(?:finds?|options?|class(?:es)?|programs?|activit(?:y|ies)|camps?|swim\w*|gym\w*|lessons?|listings?|sessions?|nearby|good\s+ones|keep\s+looking|keep\s+digging|keep\s+searching|details|breakdown|rundown|write[-\s]?up|walkthrough|checklist)\b/i;

/** Hale promises to change how Hale behaves. */
const CEASE_VERB =
  /\b(?:cut|stop|skip|drop|quit|avoid|no\s+longer|knock\s+off|hold\s+off\s+on|stop\s+sending)\b/i;
/** ...about its own output, which is the only thing that makes it self-referential
 * rather than a promise about the family's week. */
const OWN_OUTPUT =
  /\b(?:messages?|texts?|texting|replies|reply|replying|one\s+sec|updates?|notifications?|pings?|check[-\s]?ins?|nudges?)\b/i;

/** An assertion that a placement EXISTS. */
const SCHEDULED_ASSERTION =
  /\b(?:is|are|'s|'re)\s+(?:booked|scheduled|confirmed|on\s+your\s+calendar|in\s+your\s+calendar)\b|\bi'?(?:ve|\s+have)\s+(?:booked|added|scheduled|put)\b|\byou'?re\s+(?:booked|registered|signed\s+up|all\s+set)\b/i;

/** Words that carry no subject — dropped before a `scheduled_event` is matched against
 * what is actually on the family's calendar. */
const EMPTY_WORDS = new Set([
  'your',
  'their',
  'this',
  'that',
  'with',
  'from',
  'have',
  'been',
  'there',
  'here',
  'they',
  'them',
  'into',
  'just',
  'still',
  'next',
  'last',
  'week',
  'weeks',
  'today',
  'tomorrow',
  'booked',
  'scheduled',
  'confirmed',
  'calendar',
  'added',
  'already',
  'going',
  'about',
  'what',
  'when',
  'over',
  'well',
  'good',
  'ones',
]);

function contentWords(sentence: string): string[] {
  return [
    ...new Set(
      sentence
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .split(' ')
        .filter((word) => word.length >= 4 && !EMPTY_WORDS.has(word)),
    ),
  ];
}

/** Everything inside double quotes is somebody else's sentence. Removed before the
 * first-person patterns run, so `Your note said "I'll sign her up Monday"` reads as the
 * report it is. Single quotes are left alone — `I'll` contains one. */
function withoutQuotedSpans(sentence: string): string {
  return sentence.replace(/["“”][^"“”]*["“”]/g, ' ');
}

function kindOf(sentence: string): ClaimKind | null {
  // A question is a proposal, not a claim. "Want me to watch that morning?" asks for
  // permission Hale does not yet have, and refusing it would refuse the honest move.
  if (sentence.trimEnd().endsWith('?')) return null;

  const text = withoutQuotedSpans(sentence);
  if (REPORTED_SPEECH.test(text)) return null;
  if (FIRST_PERSON_NEGATED.test(text)) return null;

  const speaks = FIRST_PERSON_FUTURE.test(text) || FIRST_PERSON_PROGRESSIVE.test(text);
  if (speaks) {
    if (CEASE_VERB.test(text) && OWN_OUTPUT.test(text)) return 'self_referential';
    if (NOTIFY_VERB.test(text) && REGISTRATION_SUBJECT.test(text)) return 'registration_watch';
    if (RETURN_VERB.test(text) && ACTIVITY_SUBJECT.test(text)) return 'activity_followup';
  }
  const assertion = SCHEDULED_ASSERTION.exec(text);
  if (assertion && !NEGATIVE_SUBJECT.test(text.slice(0, assertion.index + 2))) {
    return 'scheduled_event';
  }
  return null;
}

/**
 * Every claim this body makes, in the order it makes them.
 *
 * An empty array is the ordinary answer and means exactly what it says: nothing in here
 * asserts a row. It does NOT mean the message is true — only that nothing in it is this
 * primitive's to check.
 */
export function extractStateClaims(body: string): StateClaim[] {
  const claims: StateClaim[] = [];
  for (const sentence of sentencesOf(body)) {
    const kind = kindOf(sentence);
    if (kind === null) continue;
    claims.push({
      sentence,
      kind,
      words: kind === 'scheduled_event' ? contentWords(sentence) : [],
    });
  }
  return claims;
}

/**
 * The claims that are false whatever the database says — the half of the primitive that
 * needs no query and therefore runs at the seams that have no database handle.
 *
 * ONE READER with the full reconcile (reconcile.ts routes the same kind to the same
 * refusal), so a choke point and a coach turn cannot disagree about whether a sentence
 * is sendable.
 */
export function claimsNoLedgerCanBack(body: string): StateClaim[] {
  return extractStateClaims(body).filter((claim) => claim.kind === 'self_referential');
}
