import type { FriendVoiceInput, OfferedConnector } from './friend-voice';
import {
  EMPTY_ONBOARDING_CAPTURE,
  type KidActivity,
  type OnboardingCapture,
} from './onboarding-turn';

/**
 * VIL-721 · the deterministic stand-in for the onboarding model on the v2 walk, shared by
 * the fake-store golden and the real-Postgres one. It reads the plain test texts so the
 * walk can be driven; production never parses a parent's message.
 */

export const FIND_MESSAGE = '1. Swim at the rec centre - Saturday\n2. Story time - Tuesday';

export type WireCapture = Omit<OnboardingCapture, 'parentRole'> & {
  parentRole: 'mother' | 'father' | 'unknown' | null;
  parentRoleBasis: 'stated' | 'guessed' | null;
  activities?: KidActivity[];
  activitiesNone?: boolean;
  connectGoogle?: boolean | null;
};

export interface ScriptedTurn {
  reply: string;
  capture: WireCapture;
  groupLeads?: string[];
  asks?: boolean;
  connectorsOffered?: OfferedConnector[];
  joinPointer?: 'below' | 'wrong_owner' | 'placeholder' | 'hale_starts' | 'missing' | null;
}

/**
 * The stand-in for the onboarding model on the v2 walk: postal, kids, ages, the map,
 * the activities, the name, the one Google link, schedule, co-parent.
 */
export function v2Turn(input: FriendVoiceInput): ScriptedTurn {
  const words = input.parentWords.trim();
  const capture: WireCapture = {
    ...EMPTY_ONBOARDING_CAPTURE,
    children: [],
    scheduleAdds: [],
    parentRole: null,
    parentRoleBasis: null,
    language: input.language ?? 'en',
  };
  const postal = words.match(/\b([A-Z]\d[A-Z])[ -]?(\d[A-Z]\d)\b/i);
  if (postal?.[1] && postal[2]) capture.postalCode = `${postal[1]} ${postal[2]}`.toUpperCase();
  const bareAge = words.match(/^(?:she|he)(?:'s| is)\s+(\d{1,2})$/i);
  if (bareAge?.[1]) {
    capture.children = [{ name: null, ageMonths: Number(bareAge[1]) * 12, agePrecision: 'years' }];
  }
  if (input.step === 'kids_names' && /^[A-Z][a-z]+$/.test(words)) {
    capture.children = [{ name: words, ageMonths: null, agePrecision: null }];
  }
  if (/^dana$/i.test(words)) {
    capture.parentName = 'Dana';
    capture.parentRole = 'unknown';
    capture.parentRoleBasis = 'guessed';
  }
  // The activities, as the model would read them from the parent's own words.
  if (input.step === 'activities' && /swims/i.test(words)) {
    capture.activities = [{ child: 'Maya', activity: 'swim lessons', when: 'Saturdays' }];
  }
  if (input.step === 'activities' && /^nothing yet$/i.test(words)) capture.activitiesNone = true;
  const yes = /^(yes|yeah|yep)$/i.test(words);
  if (yes && input.step === 'google') capture.connectGoogle = true;
  if (yes && input.step === 'coparent') capture.coparentGroup = true;
  if (yes && input.step === 'schedule' && (input.scheduled ?? []).length === 0) {
    capture.scheduleAdds = [
      { line: 1, cadence: 'weekly', date: '2026-08-01', time: null, weeks: null },
    ];
  }
  if (input.step === 'schedule' && (input.scheduled ?? []).length > 0) capture.scheduleDone = true;
  if (/^(no|nope)$/i.test(words) && input.step === 'google') capture.connectGoogle = false;

  const known = input.checklist;
  const postalKnown = Boolean(capture.postalCode) || Boolean(input.placeLabel) || known?.postal;
  const kidsKnown = capture.children.some((child) => child.name) || known?.kids === true;
  const agesKnown =
    capture.children.some((child) => child.ageMonths != null) ||
    input.ageMonths.length > 0 ||
    known?.ages === true;
  // A dark checklist has no activities or Google item: the dark walk never asks them.
  const activitiesKnown =
    (capture.activities?.length ?? 0) > 0 ||
    capture.activitiesNone === true ||
    known?.activities !== false;
  const nameKnown = Boolean(capture.parentName) || Boolean(input.parentName) || known?.name;
  const googleKnown = capture.connectGoogle != null || known?.google !== false;
  const scheduleKnown = capture.scheduleDone || known?.schedule === true;
  const coparentKnown = capture.coparentGroup != null || known?.coparent === true;
  const who = capture.parentName || input.parentName;

  if (input.step === 'find_show') {
    return {
      reply: 'Here is what is on near you for their ages.',
      capture,
      groupLeads: (input.findGroups ?? []).map((group) => group.lines.join('\n')),
    };
  }
  if (capture.scheduleAdds.length > 0) {
    return { reply: 'Done, a weekly reminder for the first one.', capture };
  }
  if (input.step === 'coparent' && capture.coparentGroup === true) {
    return { reply: 'The number is below whenever you want.', capture, joinPointer: 'below' };
  }
  // The yes to the one link: its receipt, about both, asking nothing.
  if (input.step === 'google' && capture.connectGoogle === true && !known?.google) {
    return {
      reply:
        "Great, the link is right there. Tap it when you're ready and I'll text you what I see.",
      capture,
      connectorsOffered: ['gmail', 'calendar'],
    };
  }
  let ask: string;
  let connectorsOffered: OfferedConnector[] = [];
  if (!postalKnown) ask = "Hey, it's Hale. What's your postal code?";
  else if (!kidsKnown) ask = "What are your kids' names?";
  else if (!agesKnown) ask = 'How old are your kids?';
  else if (!activitiesKnown) ask = 'What do the kids already do, like a class or a sport?';
  else if (!nameKnown) ask = 'What should I call you?';
  else if (!googleKnown) {
    ask = `Google shows its own "unverified app" screen first: tap Advanced, then continue. ${
      who ? `${who}, want` : 'Want'
    } me to connect Gmail and your calendar with one tap?`;
    connectorsOffered = ['gmail', 'calendar'];
  } else if (!scheduleKnown && input.findLines.length > 0) {
    ask = 'Want the first one on your calendar as a weekly reminder?';
  } else if (!coparentKnown) ask = 'Want me to set up a group chat with the other parent?';
  else ask = "I'll take it from here.";
  return { reply: ask, capture, asks: ask.endsWith('?'), connectorsOffered };
}

export function findResult() {
  return {
    message: FIND_MESSAGE,
    itemCount: 2,
    followUpNeeded: false,
    checkpointTold: null,
    weekendPickOffered: false,
    findWon: true,
    firstFindPromised: false,
    actionMove: null,
    actionHeld: 'no_move' as const,
    voiceFallback: null,
  };
}
