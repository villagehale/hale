import type { ReplyLanguage } from '../language';

/**
 * VIL-456 — what the model is handed for one shared-group line.
 *
 * Code owns every fact. The model writes the words. Facts come from this chat
 * and from numbers Hale already knows. Private family surfaces are never here.
 */

export const SHARED_GROUP_VOICE_SKILL = 'shared-group-voice' as const;

export type SharedGroupVoiceKind =
  | 'intro'
  | 'who_confirmed'
  | 'answer'
  | 'member_stop'
  | 'family_left'
  | 'family_ask';

export type SharedGroupVoiceRequest =
  | { kind: 'intro'; adderFirstName: string | null }
  | {
      kind: 'who_confirmed';
      name: string | null;
      roleWord: string | null;
      kidFirstName: string | null;
    }
  | { kind: 'answer'; lookup: { title: string; when: string | null; place: string | null } | null }
  | { kind: 'member_stop'; name: string | null }
  | { kind: 'family_left'; leaverFirstName: string | null }
  | { kind: 'family_ask'; askeeFirstName: string; about: string };

export interface SharedGroupThreadLine {
  speaker: string | null;
  text: string;
}

export interface SharedGroupLine {
  skill: typeof SHARED_GROUP_VOICE_SKILL;
  kind: SharedGroupVoiceKind;
  language: ReplyLanguage;
  address: 'vous';
  parentWords: string | null;
  facts: Record<string, unknown>;
  threadSaid: SharedGroupThreadLine[];
  questions: 0 | 1;
  mayDecline: boolean;
  maxChars: number;
  wayOut?: boolean;
}

function named(...values: ReadonlyArray<string | null | undefined>): string[] {
  return values.filter((value): value is string => typeof value === 'string' && value.length > 0);
}

export function sharedGroupLineInput(
  request: SharedGroupVoiceRequest,
  language: ReplyLanguage,
  options: { parentWords?: string | null; threadSaid?: readonly SharedGroupThreadLine[] } = {},
): SharedGroupLine {
  const threadSaid = [...(options.threadSaid ?? [])];
  const parentWords = options.parentWords ?? null;
  const base = {
    skill: SHARED_GROUP_VOICE_SKILL,
    language,
    address: 'vous' as const,
    parentWords,
    threadSaid,
  };

  switch (request.kind) {
    case 'intro':
      return {
        ...base,
        kind: 'intro',
        facts: { adderFirstName: request.adderFirstName },
        questions: 1,
        mayDecline: false,
        maxChars: 240,
      };
    case 'who_confirmed':
      return {
        ...base,
        kind: 'who_confirmed',
        facts: {
          name: request.name,
          roleWord: request.roleWord,
          kidFirstName: request.kidFirstName,
        },
        questions: 0,
        mayDecline: false,
        maxChars: 160,
      };
    case 'answer':
      return {
        ...base,
        kind: 'answer',
        facts: { lookup: request.lookup },
        questions: 0,
        mayDecline: true,
        maxChars: 260,
      };
    case 'member_stop':
      return {
        ...base,
        kind: 'member_stop',
        facts: { name: request.name },
        questions: 0,
        mayDecline: false,
        maxChars: 120,
        wayOut: true,
      };
    case 'family_left':
      return {
        ...base,
        kind: 'family_left',
        facts: { leaverFirstName: request.leaverFirstName },
        questions: 0,
        mayDecline: false,
        maxChars: 140,
      };
    case 'family_ask':
      return {
        ...base,
        kind: 'family_ask',
        facts: { askeeFirstName: request.askeeFirstName, about: request.about },
        questions: 1,
        mayDecline: true,
        maxChars: 160,
      };
  }
}

export function sharedGroupFactStrings(input: SharedGroupLine): string[] {
  return [
    ...named(
      input.parentWords,
      ...input.threadSaid.map((line) => line.speaker),
      ...input.threadSaid.map((line) => line.text),
    ),
    ...factValues(input.facts),
  ];
}

function factValues(value: unknown): string[] {
  if (typeof value === 'string') return named(value);
  if (typeof value === 'number') return [String(value)];
  if (Array.isArray(value)) return value.flatMap(factValues);
  if (value && typeof value === 'object') return Object.values(value).flatMap(factValues);
  return [];
}
