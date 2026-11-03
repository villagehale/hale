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
 * FIVE CLAIM FAMILIES, and the taxonomy is closed on purpose (see {@link ClaimKind}).
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
 * The five things a message can claim that this primitive knows how to check.
 *
 * Each maps to exactly one question in reconcile.ts, and three of the five can be
 * answered yes. `self_referential` never can — a promise about how Hale behaves has no
 * table. `co_parent_invite` never can either: the invite path sends, then says so, and
 * a model sentence is not that path.
 */
export type ClaimKind =
  /** "I'm watching that morning and I'll text you before it goes live." */
  | 'registration_watch'
  /** "I'll check the details and text you the good ones." */
  | 'activity_followup'
  /** "Your well-baby visit is booked." — an assertion that a placement exists. */
  | 'scheduled_event'
  /** "I'll cut the one sec messages and just answer." — a promise about Hale itself. */
  | 'self_referential'
  /**
   * "I'll send an invite to that number." The 2026-09-24 Linq turn: the model said
   * the invite left, and the number was never texted.
   */
  | 'co_parent_invite';

export interface StateClaim {
  /**
   * The sentence exactly as it appears in the body. It is the SPAN, not a paraphrase,
   * because a lane that cannot re-ask has one honest move left: drop the sentence and
   * send what survives. That only works if the string can be found again. Several claims
   * may share one sentence, and the sentence is sendable only if every one of them is
   * backed.
   */
  sentence: string;
  /**
   * This claim's own span inside `sentence`, verbatim: the booking's clause, or the
   * promise's segment (the whole sentence when only the whole-sentence reading made it).
   */
  clause: string;
  kind: ClaimKind;
  /**
   * The claim's content words, lowercased — what a `scheduled_event` is matched on. They
   * come from `clause`, or from the clauses it leans on when `clause` names nothing
   * ("that's booked"), so an activity named elsewhere in the sentence cannot back the
   * booking. Empty for the promise families, which are matched by KIND against the
   * ledger and never by their words.
   */
  words: readonly string[];
}

/**
 * Sentence-ish. SMS bodies are two segments of plain ASCII, so terminal punctuation and
 * newlines are the whole grammar. The sentence is the span a lane drops; a dash-joined
 * clause stays inside it, and what each clause claims is read separately below.
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
/** The registration morning, named as ITSELF. Deliberately NOT "window" or "spot": the
 * ladder's own check-in reply says "I'll flag the next Halton Hills window early", and
 * that sentence is about a cycle nobody has published yet.
 *
 * This is the CLAIM'S kind, not what a course page may back: reconcile.ts reads the
 * watched OBJECT ("fall registration", "the registration morning") on its own, because
 * "so you can register" on a one-class ack is a purpose, not a season (VIL-337). */
const REGISTRATION_NAMED = /\b(?:registration|register|registering|sign[-\s]?ups?|signing\s+up)\b/i;
/** ...or named by what it is about to do, which is the half a class page shares. */
const REGISTRATION_OPENING = /\b(?:opens?|opening|goes?\s+live|go\s+live|doors\s+open)\b/i;

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
 * match", the ladder's "your plan the evening before" — and none of them
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

/** Everything inside double quotes is somebody else's sentence. Blanked before the
 * first-person patterns run, so `Your note said "I'll sign her up Monday"` reads as the
 * report it is. Single quotes are left alone — `I'll` contains one.
 *
 * Blanked with spaces of EQUAL LENGTH, so an offset into the result is an offset into the
 * sentence: clauses are found on this copy and cut from the original. Splitting first
 * would cut inside `"swim, and the visit, are booked"` and leave halves that no longer
 * hold a matched quote pair, turning the parent's quoted words into Hale's claim. */
function withoutQuotedSpans(sentence: string): string {
  return sentence.replace(/["“”][^"“”]*["“”]/g, (quoted) => ' '.repeat(quoted.length));
}

/** Hale says it has invited someone, or that it is about to. Negation is already out. */
function isCoParentInviteClaim(text: string): boolean {
  const future = /\bi(?:['’]ll|\s+will|['’]m\s+going\s+to|\s+am\s+going\s+to)\b/i;
  const already = /\bi(?:['’]ve|\s+have)\s+(?:sent|texted)\b/i;
  if (!future.test(text) && !already.test(text)) return false;
  // "I'll invite them" and "I'll send an invite" and "I'll send an invitation".
  return /\b(?:invite|invitation)\b/i.test(text);
}

type PromiseKind = Exclude<ClaimKind, 'scheduled_event'>;

/**
 * Which promise a stretch of text makes, if any. The families are RIVAL READINGS OF ONE
 * PROMISE VERB, which is why the first match wins: "I'm watching that summer camp page
 * and I'll text you the moment a spot opens" is one watch, not a watch plus a follow-up.
 * A booking assertion is not a reading of a promise verb, so it is not in here — it is
 * read clause by clause in {@link extractStateClaims}, whatever this returns.
 */
function promiseKindOf(span: string): PromiseKind | null {
  // A question is a proposal, not a claim. "Want me to watch that morning?" asks for
  // permission Hale does not yet have, and refusing it would refuse the honest move.
  if (span.trimEnd().endsWith('?')) return null;

  const text = withoutQuotedSpans(span);
  if (REPORTED_SPEECH.test(text)) return null;
  if (FIRST_PERSON_NEGATED.test(text)) return null;
  // Before the other first-person families. "I'll send an invite" also contains a
  // notify verb, and classifying it as a watch or a follow-up would let a ledger
  // row about something else back a text to a stranger. A sentence that holds an invite
  // and anything else still carries this claim, and it is always refused, so no row
  // about the other thing can back the sentence.
  if (isCoParentInviteClaim(text)) return 'co_parent_invite';

  const speaks = FIRST_PERSON_FUTURE.test(text) || FIRST_PERSON_PROGRESSIVE.test(text);
  if (speaks) {
    if (CEASE_VERB.test(text) && OWN_OUTPUT.test(text)) return 'self_referential';
    if (
      NOTIFY_VERB.test(text) &&
      (REGISTRATION_NAMED.test(text) || REGISTRATION_OPENING.test(text))
    ) {
      return 'registration_watch';
    }
    if (RETURN_VERB.test(text) && ACTIVITY_SUBJECT.test(text)) return 'activity_followup';
  }
  return null;
}

/**
 * Where one clause of a sentence ends and the next begins. SOFT breaks (a comma before a
 * word, a colon before a space) let a negation or a report reach on into the clauses after
 * it — "You said that, for Tuesday, the visit is booked" is all the parent's. HARD breaks
 * stop it, so "I can't hold a spot for you, but your visit is booked" still claims the
 * booking. `Nov 4, 2026`, `7:00`, `11/4` and `well-baby` are not breaks.
 *
 * This list is an evasion table, not a grammar: a connective outside it leaves two
 * clauses joined, which is never weaker than reading the whole sentence as one.
 */
const CLAUSE_BREAK =
  /,(?=\s+\D)|:(?=\s)|;|\s[-–—]\s|—|…|\.\.\.|&|(?<!\d)\/|\/(?!\d)|\b(?:and|but|plus|so|also|while|then)\b/gi;
const SOFT_BREAKS = new Set([',', ':']);

/** Where Hale (or someone it is reporting) starts to speak. */
const OPENERS = [
  FIRST_PERSON_FUTURE,
  FIRST_PERSON_PROGRESSIVE,
  FIRST_PERSON_NEGATED,
  REPORTED_SPEECH,
].map((pattern) => new RegExp(pattern.source, `${pattern.flags}g`));

/** A clause whose words take the clauses it governs out of Hale's mouth. */
const FRAMES = [REPORTED_SPEECH, FIRST_PERSON_NEGATED, NEGATIVE_SUBJECT];

const KIND_ORDER: readonly ClaimKind[] = [
  'registration_watch',
  'activity_followup',
  'scheduled_event',
  'self_referential',
  'co_parent_invite',
];

interface Clause {
  start: number;
  end: number;
  /** The break before this clause was hard. */
  hardBefore: boolean;
  /** Blanked of quoted spans: what the patterns read. */
  masked: string;
  /** Verbatim: what the claim carries and its words come from. */
  text: string;
}

function clausesOf(sentence: string, masked: string): Clause[] {
  const clauses: Clause[] = [];
  let cursor = 0;
  let hard = false;
  const close = (end: number) => {
    const raw = sentence.slice(cursor, end);
    if (raw.trim() === '') return;
    const start = cursor + (raw.length - raw.trimStart().length);
    const stop = cursor + raw.trimEnd().length;
    clauses.push({
      start,
      end: stop,
      hardBefore: hard,
      masked: masked.slice(start, stop),
      text: sentence.slice(start, stop),
    });
    hard = false;
  };
  for (const found of masked.matchAll(CLAUSE_BREAK)) {
    close(found.index);
    if (!SOFT_BREAKS.has(found[0])) hard = true;
    cursor = found.index + found[0].length;
  }
  close(sentence.length);
  return clauses;
}

function openerStarts(masked: string): number[] {
  const starts = new Set<number>();
  for (const pattern of OPENERS) {
    for (const found of masked.matchAll(pattern)) starts.add(found.index);
  }
  return [...starts].sort((a, b) => a - b);
}

interface Placed {
  claim: StateClaim;
  position: number;
}

/**
 * The promises a sentence makes. One opener means one promise verb, read over the whole
 * sentence exactly as before. A second opener in a later clause starts a second promise —
 * "I'll text you when registration opens, and I'll keep looking for swim classes" owes
 * two rows — and each segment carries its own exemptions, so "I can't hold a spot, but
 * I'll keep looking" still makes the second promise. The whole-sentence reading is kept,
 * so this set only ever grows. Kinds are deduplicated because promises are matched by
 * kind and never by words: two of one kind get the same verdict.
 */
function promiseClaims(
  sentence: string,
  clauses: readonly Clause[],
  openers: readonly number[],
): Placed[] {
  const openerClauses = [
    ...new Set(
      openers.map((at) => clauses.findIndex((clause) => at >= clause.start && at < clause.end)),
    ),
  ].filter((index) => index >= 0);
  const cuts = [0, ...openerClauses.slice(1).map((index) => (clauses[index] as Clause).start)];
  const segments =
    cuts.length > 1 ? cuts.map((start, i) => ({ start, end: cuts[i + 1] ?? sentence.length })) : [];
  const readings = [
    ...segments.map((segment) => ({
      ...segment,
      kind: promiseKindOf(sentence.slice(segment.start, segment.end)),
    })),
    { start: 0, end: sentence.length, kind: promiseKindOf(sentence) },
  ];
  const placed = new Map<PromiseKind, Placed>();
  for (const reading of readings) {
    if (reading.kind === null || placed.has(reading.kind)) continue;
    placed.set(reading.kind, {
      claim: {
        sentence,
        clause: sentence.slice(reading.start, reading.end).trim(),
        kind: reading.kind,
        words: [],
      },
      position: openers.find((at) => at >= reading.start && at < reading.end) ?? reading.start,
    });
  }
  return [...placed.values()];
}

/**
 * The booking assertions a sentence makes, one claim per clause that holds one, whatever
 * the promise reading says.
 *
 * EXEMPT only where something governs the clause: a report, a negation or a "nothing" in
 * the clause itself (a "nothing" only before the assertion — "Your visit is booked,
 * nothing else is" claims the visit), or in an earlier clause reached through soft breaks
 * with no opener of its own in between; or the sentence's last clause ending in `?`.
 *
 * WORDS come from the clause. A clause that names nothing ("that's booked", "is booked")
 * leans on its neighbours, nearest first, and never across a clause where Hale starts
 * speaking — that clause is about something else. A neighbour that is itself a booking
 * is the same placement said twice ("Swim is booked, so you're all set"), so the walk
 * takes its words and stops.
 */
function bookingClaims(
  sentence: string,
  clauses: readonly Clause[],
  openers: readonly number[],
): Placed[] {
  const holdsOpener = (index: number) => {
    const clause = clauses[index] as Clause;
    return openers.some((at) => at >= clause.start && at < clause.end);
  };
  const asserts = (index: number) => SCHEDULED_ASSERTION.test((clauses[index] as Clause).masked);
  const framed = (index: number) =>
    FRAMES.some((frame) => frame.test((clauses[index] as Clause).masked));

  const governed = (index: number, assertionAt: number) => {
    const own = (clauses[index] as Clause).masked;
    if (REPORTED_SPEECH.test(own) || FIRST_PERSON_NEGATED.test(own)) return true;
    if (NEGATIVE_SUBJECT.test(own.slice(0, assertionAt + 2))) return true;
    for (let earlier = index - 1; earlier >= 0; earlier -= 1) {
      const next = clauses[earlier + 1] as Clause;
      if (next.hardBefore || holdsOpener(earlier + 1)) return false;
      if (framed(earlier)) return true;
    }
    return false;
  };

  const lean = (index: number, step: -1 | 1) => {
    const words: string[] = [];
    for (let other = index + step; other >= 0 && other < clauses.length; other += step) {
      if (holdsOpener(other)) break;
      words.push(...contentWords((clauses[other] as Clause).text));
      if (asserts(other)) break;
    }
    return words;
  };

  const asksLast = sentence.trimEnd().endsWith('?');
  const placed: Placed[] = [];
  clauses.forEach((clause, index) => {
    const assertion = SCHEDULED_ASSERTION.exec(clause.masked);
    if (!assertion) return;
    if (governed(index, assertion.index)) return;
    if (asksLast && index === clauses.length - 1) return;
    const own = contentWords(clause.text);
    const borrowed = own.length > 0 ? own : lean(index, -1);
    const words = borrowed.length > 0 ? borrowed : lean(index, 1);
    placed.push({
      claim: { sentence, clause: clause.text, kind: 'scheduled_event', words: [...new Set(words)] },
      position: clause.start,
    });
  });
  return placed;
}

/**
 * Every claim this body makes, in the order it makes them — EVERY claim in a sentence,
 * not the first one found. A sentence that pairs a real follow-up with a booking nothing
 * backs carries both, and reconcile refuses the sentence on the booking.
 *
 * An empty array is the ordinary answer and means exactly what it says: nothing in here
 * asserts a row. It does NOT mean the message is true — only that nothing in it is this
 * primitive's to check.
 */
export function extractStateClaims(body: string): StateClaim[] {
  const claims: StateClaim[] = [];
  for (const sentence of sentencesOf(body)) {
    const masked = withoutQuotedSpans(sentence);
    const clauses = clausesOf(sentence, masked);
    const openers = openerStarts(masked);
    const placed = [
      ...promiseClaims(sentence, clauses, openers),
      ...bookingClaims(sentence, clauses, openers),
    ].sort(
      (a, b) =>
        a.position - b.position ||
        KIND_ORDER.indexOf(a.claim.kind) - KIND_ORDER.indexOf(b.claim.kind),
    );
    claims.push(...placed.map(({ claim }) => claim));
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
  // `co_parent_invite` is in this set on purpose. The SMS invite path says it
  // sent only after the SMS door accepts, and that ack does not match this claim.
  // A model sentence ("I'll send an invite", "I'll invite them") has no row
  // that makes it true, on Linq or anywhere else. The dispatch choke has no
  // database, so this is the gate that keeps the sentence off every template.
  return extractStateClaims(body).filter(
    (claim) => claim.kind === 'self_referential' || claim.kind === 'co_parent_invite',
  );
}
