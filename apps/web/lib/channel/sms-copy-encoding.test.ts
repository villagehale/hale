import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ActionType } from '@hale/types';
import { describe, expect, it } from 'vitest';
import { approvedReceipt, declinedReceipt } from '~/lib/channel/router/copy';
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
  'lib/channel/caregiver/copy.ts',
  'lib/channel/twilio/copy.ts',
  'lib/health/copy.ts',
  'lib/registration/sequence/copy.ts',
  'lib/party/copy.ts',
  'lib/party/guest-copy.ts',
  'lib/party/tally.ts',
  'lib/format/labels.ts',
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
