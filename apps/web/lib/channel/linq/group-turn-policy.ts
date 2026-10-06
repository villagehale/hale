import { type IntakeKeyword, matchKeyword } from '~/lib/channel/intake/keywords';

/**
 * Group onboarding v2, §4 — whether a message in the family group is Hale's to answer.
 *
 * Decided in code, before the coach runs. In a group Hale is one voice among the family:
 * it answers when someone speaks to it by name, or asks a question about a kid or the
 * day's logistics. A parent talking to the other parent is not a turn, so it costs no
 * model call, no ledger row and no budget. A CASL keyword always routes.
 */

export type GroupTurnDecision =
  | { route: 'keyword'; keyword: IntakeKeyword }
  | { route: 'coach'; reason: 'addressed' | 'question' }
  | { route: 'duty' }
  | { route: 'ignore'; outcome: 'group_chatter_ignored' };

const NOT_LETTER_BEFORE = '(?<![\\p{L}\\p{N}])';
const NOT_LETTER_AFTER = '(?![\\p{L}\\p{N}])';

function wordPattern(alternatives: string): RegExp {
  return new RegExp(`${NOT_LETTER_BEFORE}(?:${alternatives})${NOT_LETTER_AFTER}`, 'iu');
}

const ADDRESSED = wordPattern('@?hale');

const LOGISTICS = wordPattern(
  [
    'pick ?-?up',
    'picking up',
    'drop ?-?off',
    'dropping off',
    'when',
    'where',
    'what time',
    'time',
    "who's taking",
    'who is taking',
    'quand',
    'où',
    'quelle heure',
    'qui prend',
    'qui va chercher',
    'chercher',
    'déposer',
    'ramasser',
  ].join('|'),
);

const DUTY = wordPattern(
  [
    "i'?ll (?:take|grab|get|do|drive|pick)",
    'i will (?:take|grab|get|do|drive|pick)',
    "i(?:'ve)? got (?:it|them|him|her)",
    'je prends',
    "je m'en occupe",
    'je vais (?:chercher|prendre)',
  ].join('|'),
);

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function namesKid(text: string, kidNames: readonly string[]): boolean {
  return kidNames.some((name) => {
    const trimmed = name.trim();
    return trimmed.length > 0 && wordPattern(escapeRegExp(trimmed)).test(text);
  });
}

export function decideGroupTurn(input: {
  text: string;
  kidNames: readonly string[];
}): GroupTurnDecision {
  const keyword = matchKeyword(input.text);
  if (keyword) return { route: 'keyword', keyword: keyword.keyword };

  const text = input.text.replace(/[‘’]/g, "'");
  if (ADDRESSED.test(text)) return { route: 'coach', reason: 'addressed' };
  if (text.includes('?') && (namesKid(text, input.kidNames) || LOGISTICS.test(text))) {
    return { route: 'coach', reason: 'question' };
  }
  if (DUTY.test(text)) return { route: 'duty' };
  return { route: 'ignore', outcome: 'group_chatter_ignored' };
}
