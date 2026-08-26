import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ActionType } from '@hale/types';
import { describe, expect, it } from 'vitest';
import { CO_PARENT_REDIRECT } from '~/lib/channel/caregiver/copy';
import {
  AMBIGUOUS_CLARIFY,
  AMBIGUOUS_CLARIFY_BY_LANGUAGE,
  ASSENT_ACK,
  ASSENT_ACK_BY_LANGUAGE,
  COLD_START_ASK_BY_LANGUAGE,
  DECLINE_ACK,
  DECLINE_ACK_BY_LANGUAGE,
  HELP_REPLY,
  HELP_REPLY_BY_LANGUAGE,
  REGION_UNAVAILABLE_REPLY,
  REGION_UNAVAILABLE_REPLY_BY_LANGUAGE,
  START_ACK,
  START_ACK_BY_LANGUAGE,
  STOP_ACK,
  STOP_ACK_BY_LANGUAGE,
  WATCH_OFFER,
  WATCH_OFFER_BY_LANGUAGE,
  detailsBlocked,
  followUp,
  greeting,
} from '~/lib/channel/intake/copy';
import {
  ANSWER_UNAVAILABLE_REPLY,
  ANSWER_UNAVAILABLE_REPLY_BY_LANGUAGE,
  DIRECT_ACCESS_EYE_REPLY,
  PROVIDER_ACCESS_REPLY,
  PROVIDER_ACCESS_REPLY_BY_LANGUAGE,
  SAFETY_REPLY,
  SAFETY_REPLY_BY_LANGUAGE,
  UNPLACEABLE_PROVIDER_REPLY,
  UNPLACEABLE_PROVIDER_REPLY_BY_LANGUAGE,
} from '~/lib/channel/off-domain/copy';
import {
  approvedReceipt,
  declinedReceipt,
  failureReply,
  partialFailureReply,
  whichOneReply,
} from '~/lib/channel/router/copy';
import { mediaUnsupportedReply } from '~/lib/channel/twilio/copy';
import { PRIVACY_URL } from '~/lib/legal-links';
import { smsEncoding, smsSegments } from './sms-segments';

/**
 * VIL-265 — the structural tripwire under every word Hale texts.
 *
 * ONE character outside GSM-7 re-encodes the WHOLE body as UCS-2 and cuts the budget
 * from 160 characters to 70, so a typographic em dash nobody can see on a phone turns a
 * one-segment reply into three: three times the carrier bill on every send, forever,
 * and a silent third of the ≤2-segment budget the voice rules promise. Copy review
 * cannot catch it — an em dash and a hyphen are the same mark to a reader.
 *
 * So it is checked mechanically, at the AUTHORING site rather than at the transport.
 * The transport is the wrong place: it also carries names a family typed, and folding
 * there would quietly mangle a child whose name is not spellable in a 1985 alphabet.
 * What must be GSM-7 is what HALE wrote.
 *
 * The alphabet is not restated here — every character is judged by the same
 * {@link smsEncoding} the segment counter bills on, so the guard and the cost model can
 * never disagree about what "safe" means.
 */

const WEB_ROOT = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');

/**
 * Every module that authors a deterministic outbound SMS body, apps/web-relative.
 *
 * Deliberately not the model-composed voices (radar-voice, nudge-voice, coach/reply):
 * those are not authored copy, and each already folds or rejects its own output against
 * a segment budget. `format/labels.ts` IS here even though it is shared with the web
 * UI, because the router's receipts compose an action label straight into a text — the
 * one place a UI-flavoured em dash would leak onto the carrier.
 */
const SMS_COPY_SOURCES = [
  'lib/channel/router/copy.ts',
  'lib/channel/intake/copy.ts',
  'lib/channel/off-domain/copy.ts',
  'lib/channel/caregiver/copy.ts',
  'lib/channel/twilio/copy.ts',
  'lib/channel/founder/copy.ts',
  'lib/health/copy.ts',
  'lib/registration/sequence/copy.ts',
  'lib/party/copy.ts',
  'lib/party/guest-copy.ts',
  'lib/party/tally.ts',
  'lib/village/intros/copy.ts',
  'lib/format/labels.ts',
  // Not copy itself, but SPLICED into copy: the intake consent ask now carries the
  // privacy URL from here, so a typographic character in a policy path would ride out
  // on every consent question Hale asks.
  'lib/legal-links.ts',
] as const;

/**
 * A template literal's delimiter is source punctuation, not copy, and it is the ONE
 * ASCII character GSM-7 lacks — so it is excluded rather than reported on every
 * interpolated line. Nothing else in TypeScript source is outside the alphabet, which
 * is why this scan needs no parser: comments are blanked, and every character that
 * survives is either code (ASCII, safe) or copy (the thing under test).
 */
const TEMPLATE_DELIMITER = '`';

/** Comments blanked line-for-line, so a reported line number is the real one. `//` is
 * only a comment when it does not follow a colon — `https://` is a URL in copy. */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(
      /(^|[^:])\/\/[^\n]*/g,
      (line, lead: string) => lead + ' '.repeat(line.length - lead.length),
    );
}

interface Offence {
  line: number;
  char: string;
  codePoint: string;
  text: string;
}

function nonGsm7(relativePath: string): Offence[] {
  const source = withoutComments(readFileSync(`${WEB_ROOT}/${relativePath}`, 'utf8'));
  const offences: Offence[] = [];
  source.split('\n').forEach((text, index) => {
    for (const char of text) {
      if (char === TEMPLATE_DELIMITER || smsEncoding(char) === 'gsm7') continue;
      offences.push({
        line: index + 1,
        char,
        codePoint: `U+${(char.codePointAt(0) as number).toString(16).toUpperCase().padStart(4, '0')}`,
        text: text.trim(),
      });
    }
  });
  return offences;
}

describe('outbound SMS copy stays in the GSM-7 alphabet', () => {
  it.each(SMS_COPY_SOURCES)('%s', (relativePath) => {
    // The offences are the assertion subject, so a failure names the character, the
    // line, and the copy it is in — "expected 1 to be 0" would send nobody anywhere.
    expect(nonGsm7(relativePath)).toEqual([]);
  });
});

/**
 * The other composition the file scan cannot see: intake's strings are built from a
 * constant (the privacy URL) and from runtime arguments (the venue name, the child
 * summary), so a clean copy.ts does not by itself prove a clean SENT message. Every
 * intake turn is rendered and judged by the same encoder the segment counter bills on.
 *
 * The whole onboarding script v2 is exercised, because the v2 revision rewrote all of
 * it at once and a re-keyed string is exactly when a curly quote gets pasted in.
 */
describe('the intake script stays GSM-7 once rendered', () => {
  const RENDERED: Record<string, string> = {
    'greeting (no venue)': greeting(null, 'en'),
    'greeting (venue)': greeting('EarlyON centre', 'en'),
    WATCH_OFFER,
    ASSENT_ACK,
    DECLINE_ACK,
    AMBIGUOUS_CLARIFY,
    STOP_ACK,
    HELP_REPLY,
    START_ACK,
    REGION_UNAVAILABLE_REPLY,
    'followUp (ages)': followUp('Maya (4) and Leo', ['ages']),
    'followUp (both)': followUp('Nora and Ben', ['ages', 'location']),
    'detailsBlocked (both)': detailsBlocked(['ages', 'location']),
  };

  it.each(Object.entries(RENDERED))('%s', (_name, body) => {
    expect(smsEncoding(body)).toBe('gsm7');
  });

  // The consent ask is the one intake string carrying a link, and a link is the easiest
  // thing to paste a curly character into. It must also stay ONE segment: it is appended
  // to the radar payload, where every septet is charged against the same budget.
  it('keeps the consent ask, privacy link and all, inside one GSM-7 segment', () => {
    expect(WATCH_OFFER).toContain(PRIVACY_URL);
    expect(smsSegments(WATCH_OFFER)).toBe(1);
  });
});

/**
 * THE FRENCH SCRIPT, AGAINST THE SAME ALPHABET — and this is the gate the French copy was
 * written to pass, not one it was checked against afterwards.
 *
 * GSM-7 carries é è à ù and refuses â ê î ô û ç, which is not a detail: ONE circumflex
 * flips a French message to UCS-2, where a segment is 70 characters instead of 160. The
 * greeting alone would go from two segments to four, on every French arrival, forever.
 * So the wording works around the missing characters (see the notes at each constant),
 * and this suite is what stops a later "improvement" putting one back.
 *
 * The whole-file scan above already covers these strings as SOURCE. What is added here is
 * the thing the scan cannot see — what each one costs once rendered, in the same currency
 * the carrier bills, and against the same ceilings the English twins are held to.
 */
describe('the French script stays GSM-7 and inside the English budgets', () => {
  const RENDERED: Record<string, { body: string; maxSegments: number }> = {
    'greeting (no venue)': { body: greeting(null, 'fr'), maxSegments: 2 },
    COLD_START_ASK: { body: COLD_START_ASK_BY_LANGUAGE.fr, maxSegments: 1 },
    // One segment, for the same reason the English consent ask is: it rides on the end
    // of the radar payload, where every septet comes out of the same budget.
    WATCH_OFFER: { body: WATCH_OFFER_BY_LANGUAGE.fr, maxSegments: 1 },
    ASSENT_ACK: { body: ASSENT_ACK_BY_LANGUAGE.fr, maxSegments: 1 },
    DECLINE_ACK: { body: DECLINE_ACK_BY_LANGUAGE.fr, maxSegments: 1 },
    AMBIGUOUS_CLARIFY: { body: AMBIGUOUS_CLARIFY_BY_LANGUAGE.fr, maxSegments: 1 },
    HELP_REPLY: { body: HELP_REPLY_BY_LANGUAGE.fr, maxSegments: 2 },
    START_ACK: { body: START_ACK_BY_LANGUAGE.fr, maxSegments: 1 },
    STOP_ACK: { body: STOP_ACK_BY_LANGUAGE.fr, maxSegments: 1 },
    REGION_UNAVAILABLE_REPLY: { body: REGION_UNAVAILABLE_REPLY_BY_LANGUAGE.fr, maxSegments: 1 },
    ANSWER_UNAVAILABLE_REPLY: { body: ANSWER_UNAVAILABLE_REPLY_BY_LANGUAGE.fr, maxSegments: 1 },
    SAFETY_REPLY: { body: SAFETY_REPLY_BY_LANGUAGE.fr, maxSegments: 1 },
    PROVIDER_ACCESS_REPLY: { body: PROVIDER_ACCESS_REPLY_BY_LANGUAGE.fr, maxSegments: 2 },
    UNPLACEABLE_PROVIDER_REPLY: {
      body: UNPLACEABLE_PROVIDER_REPLY_BY_LANGUAGE.fr,
      maxSegments: 2,
    },
  };

  it.each(Object.entries(RENDERED))('%s', (_name, { body, maxSegments }) => {
    expect({ encoding: smsEncoding(body), overBudget: smsSegments(body) > maxSegments }).toEqual({
      encoding: 'gsm7',
      overBudget: false,
    });
  });

  /**
   * The alphabet's refusals, named. A test that only checked `smsEncoding` would pass on
   * the day someone "fixed" the spelling of `l'age` and could not say why the bill
   * tripled — this one says which character did it.
   */
  it('names the characters French copy may not use here', () => {
    const forbidden = [...'âêîôûçœ«»’—'];
    const offenders = Object.entries(RENDERED).flatMap(([name, { body }]) =>
      forbidden.filter((char) => body.includes(char)).map((char) => `${name}: ${char}`),
    );

    expect(offenders).toEqual([]);
    // The positive control: the characters French copy MAY use are genuinely in the
    // alphabet, so the assertion above is a real constraint and not a vacuous one.
    expect(smsEncoding('é è à ù')).toBe('gsm7');
    expect(smsEncoding('â ê î ô û ç')).toBe('ucs2');
  });
});

/**
 * VIL-273 — the off-domain lane's three answers, rendered.
 *
 * The deflect is BUILT (the pending-approvals clause is appended at runtime), so a
 * clean copy.ts does not by itself prove a clean sent message. The two fixed lines are
 * scanned by the file pass above and re-checked here for their segment cost, because
 * these are the replies Hale sends most often to a parent who is not getting what they
 * asked for — the worst possible place to be paying triple.
 */
describe('the off-domain lane stays GSM-7 once rendered', () => {
  const RENDERED: Record<string, string> = {
    ANSWER_UNAVAILABLE_REPLY,
    SAFETY_REPLY,
    PROVIDER_ACCESS_REPLY,
    DIRECT_ACCESS_EYE_REPLY,
    UNPLACEABLE_PROVIDER_REPLY,
  };

  it.each(Object.entries(RENDERED))('%s', (_name, body) => {
    expect(smsEncoding(body)).toBe('gsm7');
  });

  it('keeps all five fixed lines inside the two-segment ceiling', () => {
    expect(smsSegments(ANSWER_UNAVAILABLE_REPLY)).toBe(1);
    expect(smsSegments(SAFETY_REPLY)).toBe(1);
    expect(smsSegments(PROVIDER_ACCESS_REPLY)).toBeLessThanOrEqual(2);
    expect(smsSegments(DIRECT_ACCESS_EYE_REPLY)).toBeLessThanOrEqual(2);
    expect(smsSegments(UNPLACEABLE_PROVIDER_REPLY)).toBeLessThanOrEqual(2);
  });

  /**
   * The one line in this file that carries an address, stated here rather than left to
   * pass the scheme check on a technicality.
   *
   * The no-link rule below exists so a parent is never handed the job back, and a bare
   * domain is still a link for that purpose. This one is allowed because the directory
   * IS the answer — "there is a list of optometrists" without saying where is help a
   * parent cannot act on — and it follows WATCH_OFFER's precedent: an authoritative
   * third-party address, at the moment a decision is being made, one per message. It is
   * pinned to exactly one so the exception cannot quietly widen.
   */
  it('allows the eye-care reply exactly one bare address and no more', () => {
    expect(DIRECT_ACCESS_EYE_REPLY.match(/[\w-]+\.(?:ca|com|org|net)\b/g)).toEqual([
      'FindAnEyeDoctor.ca',
    ]);
    expect(DIRECT_ACCESS_EYE_REPLY).not.toMatch(/https?:/i);
    expect(DIRECT_ACCESS_EYE_REPLY).not.toMatch(/\bthe app\b/i);
  });

  /**
   * Skill audit P0 #4. Every one of these goes to a parent who texted, and a text is
   * owed a text back — "finish it in the app" is the dead end the F14 voice rules and
   * the v3 doctrine both refuse. The pending-approvals append that used to ride on the
   * deflect is what this replaced, so the guard is on the whole file's output rather
   * than on the one line that broke it.
   */
  it.each(Object.entries(RENDERED))('%s points at no app and no link', (_name, body) => {
    expect(body).not.toMatch(/\bthe app\b/i);
    expect(body).not.toMatch(/https?:/i);
  });
});

/**
 * Skill audit P0 #4 — the copy paths that were still handing the job back.
 *
 * Founder doctrine, 2026-08-11: Hale never points a parent at the app in chat. The
 * thread IS the product, so "finish it in the app" is the work returned to the person
 * who texted to be rid of it — and it fired on exactly the messages where the job
 * mattered most: a turn that broke, an answer too long to send, a photo Hale could not
 * read. Each of these now carries what to do next IN the thread.
 *
 * SCOPED to the five the audit named. Three lines in `router/copy.ts` still carry a URL
 * and are deliberately not here: `nothingPendingReply` and `nothingToUndoReply` answer
 * "where do my records live", which is the doctrine's one stated exception, and
 * `capabilityReply` is a stub with no production caller (audit #21). Widening this to
 * the whole file is a founder call about that exception, not a test change.
 */
describe('nothing Hale texts sends a parent to the app', () => {
  const RENDERED: Record<string, string> = {
    failureReply: failureReply(),
    'partialFailureReply (1)': partialFailureReply(1),
    'partialFailureReply (2)': partialFailureReply(2),
    'whichOneReply (overflow)': whichOneReply([
      'calendar_move',
      'calendar_add',
      'calendar_cancel',
      'send_email',
      'add_to_routine',
    ]),
    mediaUnsupportedReply: mediaUnsupportedReply(),
    CO_PARENT_REDIRECT,
  };

  it.each(Object.entries(RENDERED))('%s', (_name, body) => {
    expect(body).not.toMatch(/https?:/i);
    expect(body).not.toMatch(/\bthe app\b/i);
    // Still GSM-7 and still inside the budget: a rewrite is exactly when a curly
    // apostrophe or a third segment gets in.
    expect(smsEncoding(body)).toBe('gsm7');
    expect(smsSegments(body)).toBeLessThanOrEqual(2);
  });

  /** The overflow is disclosed either way — what changed is that the rest are reachable
   * by answering the three in front of them, rather than on another surface. */
  it('discloses the approvals it could not list, without a destination', () => {
    const reply = whichOneReply(Array.from({ length: 8 }, () => 'calendar_move'));

    expect(reply).toMatch(/5 more behind those/i);
    // Disclosed WITHOUT a destination, and without a menu: the choices are named, the
    // rest are reachable by answering the ones in front (2026-08-13).
    expect(reply).not.toMatch(/\bthe app\b|https?:/i);
    expect(reply).not.toMatch(/\bYES \d|^\d\./m);
  });
});

/**
 * The composition the file scan cannot see: `labels.ts` is clean on its own, but the
 * receipt is only GSM-7 if the label it splices in is too, and the label set is keyed
 * by an enum that grows. Every member is exercised, plus the unknown-token fallback.
 */
describe('router receipts stay one GSM-7 segment for every action type', () => {
  const ACTION_TYPES = [
    'send_email',
    'reply_to_email',
    'create_calendar_event',
    'update_calendar_event',
    'place_supply_order',
    'cancel_supply_order',
    'fill_pdf_form',
    'submit_government_form',
    'book_clinic_portal',
    'cancel_clinic_appointment',
    'share_photos_with_family',
    'add_to_digest_only',
    'add_to_routine',
    'calendar_add',
    'calendar_move',
    'calendar_cancel',
  ] as const satisfies readonly ActionType[];

  it.each([...ACTION_TYPES, 'a_type_nobody_has_added_yet'])('%s', (actionType) => {
    for (const receipt of [approvedReceipt(actionType), declinedReceipt(actionType)]) {
      expect({ encoding: smsEncoding(receipt), segments: smsSegments(receipt) }).toEqual({
        encoding: 'gsm7',
        segments: 1,
      });
    }
  });
});
