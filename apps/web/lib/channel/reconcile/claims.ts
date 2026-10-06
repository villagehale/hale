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
 * SIX CLAIM FAMILIES, and the taxonomy is closed on purpose (see {@link ClaimKind}).
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
 * The six things a message can claim that this primitive knows how to check.
 *
 * Each maps to exactly one question in reconcile.ts, and four of the six can be
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
  /**
   * "Want me to move swim to Tue 4:30?" — a confirmation ask. True only when a
   * draft is already waiting for the yes. A question with no draft approves nothing.
   */
  | 'calendar_confirm'
  /**
   * "(it needs another look before it's cleared)" — reviewer machinery the
   * parent was never meant to read. Nothing in the ledger makes it true.
   */
  | 'reviewer_narration'
  /**
   * "Tuesday de cette semaine" — a French reply that named an English weekday.
   */
  | 'french_weekday'
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

/** An assertion that a placement EXISTS. "I've set it up" is this, not a draft:
 * a draft is still a question, and saying it is done is a claim about a row. */
const SCHEDULED_ASSERTION =
  /\b(?:is|are|'s|'re)\s+(?:booked|scheduled|confirmed|on\s+your\s+calendar|in\s+your\s+calendar)\b|\bi'?(?:ve|\s+have)\s+(?:booked|added|scheduled|put|moved|cancelled|canceled|set\s+it\s+up)\b|\byou'?re\s+(?:booked|registered|signed\s+up|all\s+set)\b|\bc'est\s+fait\b|\bje\s+l'ai\s+(?:d[eé]plac[eé]e?|ajout[eé]e?|annul[eé]e?|mis(?:e)?)(?![a-zà-ÿ])/i;

/** A question that asks to move, add, or cancel. Permission Hale does not have
 * yet — unless a draft is already waiting, in which case the question is the ask.
 * "check" and "watch" are not in the verb list: those questions are not a draft. */
const CALENDAR_ASK = /\b(?:want me to|shall i|should i|veux-tu|veux tu|tu veux que je)\b/i;
const CALENDAR_VERB =
  /\b(?:moves?|moving|cancels?|cancel(?:l)?ing|reschedules?|adds?|adding|puts?|plac(?:e|es|ing)|d[eé]plac(?:e|es|er)|annul(?:e|es|er)|ajout(?:e|es|er))\b/i;
const GO_AHEAD = /\bgo ahead\b/i;
/** A confirm with no verb in it: "c'est ça que tu veux?", "is that what you want?" */
const CONFIRM_WANTED =
  /\bc['’]est (?:ça|ca) que tu veux\b|\bis that what you want\b|\bthat what you (?:want|wanted)\b/i;
/** First person, present: "Je la déplace?" is the proposal, not a report of one. */
const FIRST_PERSON_CHANGE = /\bje\s+(?:(?:la|le|les|l['’])\s*)?(?:d[eé]plac|ajout|annul)/i;
/** A retry of the same change. Quiet hours will still be quiet hours. */
const DIFFERENT_SLOT =
  /\b(?:different|another)\s+(?:day|time|date)s?\b|\bun autre jour\b|\bune autre heure\b/i;

function isCalendarConfirmAsk(sentence: string): boolean {
  const text = sentence.trimEnd();
  if (!text.endsWith('?')) return false;
  if (CONFIRM_WANTED.test(text) || FIRST_PERSON_CHANGE.test(text) || DIFFERENT_SLOT.test(text)) {
    return true;
  }
  return CALENDAR_ASK.test(text) && (CALENDAR_VERB.test(text) || GO_AHEAD.test(text));
}

/** Reviewer and quiet-hours wording. The parent never sees the gate. */
const REVIEWER_NARRATION =
  /\banother look\b|\bbefore it(?:'s| is) cleared\b|\bquiet hours\b|\bnot been approved\b|\bhas(?: not|n't) been approved\b|\bwas(?: not|n't) approved\b|\bn['’]a pas (?:été|ete) approuv|\bpas (?:été|ete) approuv/i;

const EN_WEEKDAY = /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;
/** A French function word or an accent, in the same sentence as the English day. */
const FRENCH_MARKER =
  /\b(?:le|la|les|de|du|des|est|cette|semaine|pas|pour|avec|une|au|aux|déjà|deja)\b|[àâéèêëïîôùûç]/i;

function isFrenchWithEnglishWeekday(sentence: string): boolean {
  return EN_WEEKDAY.test(sentence) && FRENCH_MARKER.test(sentence);
}

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

/** Hale says it has invited someone, or that it is about to. Negation is already out. */
function isCoParentInviteClaim(text: string): boolean {
  const future = /\bi(?:['’]ll|\s+will|['’]m\s+going\s+to|\s+am\s+going\s+to)\b/i;
  const already = /\bi(?:['’]ve|\s+have)\s+(?:sent|texted)\b/i;
  if (!future.test(text) && !already.test(text)) return false;
  // "I'll invite them" and "I'll send an invite" and "I'll send an invitation".
  return /\b(?:invite|invitation)\b/i.test(text);
}

function kindOf(sentence: string): ClaimKind | null {
  // A confirmation ask is a claim about a draft. "Want me to move swim?" with
  // nothing drafted approves nothing on the next yes. Every other question is
  // still a proposal: "Want me to watch that morning?" asks for permission Hale
  // does not yet have, and refusing it would refuse the honest move.
  if (REVIEWER_NARRATION.test(sentence)) return 'reviewer_narration';
  if (isFrenchWithEnglishWeekday(sentence)) return 'french_weekday';
  if (isCalendarConfirmAsk(sentence)) return 'calendar_confirm';
  if (sentence.trimEnd().endsWith('?')) return null;

  const text = withoutQuotedSpans(sentence);
  if (REPORTED_SPEECH.test(text)) return null;
  if (FIRST_PERSON_NEGATED.test(text)) return null;
  // Before the other first-person families. "I'll send an invite" also contains a
  // notify verb, and classifying it as a watch or a follow-up would let a ledger
  // row about something else back a text to a stranger.
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
  // `co_parent_invite` is in this set on purpose. The SMS invite path says it
  // sent only after Twilio accepts, and that ack does not match this claim.
  // A model sentence ("I'll send an invite", "I'll invite them") has no row
  // that makes it true, on Linq or anywhere else. The dispatch choke has no
  // database, so this is the gate that keeps the sentence off every template.
  return extractStateClaims(body).filter(
    (claim) => claim.kind === 'self_referential' || claim.kind === 'co_parent_invite',
  );
}
