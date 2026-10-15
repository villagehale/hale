/**
 * Test-only stand-in for the onboarding model (friend voice). Shared by the
 * intake tests so every onboarding turn goes through the one path production
 * uses. The replies are fixtures, not product copy: tests assert structure
 * (what was sent, what was stored), never these words.
 */
import type { FriendVoiceComposer, FriendVoiceInput } from './friend-voice';
import { EMPTY_ONBOARDING_CAPTURE, type OnboardingCapture } from './onboarding-turn';
function offScriptAside(words: string): string | null {
  if (/who is this/i.test(words)) {
    return "I'm Hale, from Village Hale Technologies (villagehale.com). The site has the details, price included.";
  }
  if (/what is this/i.test(words)) return "I find what's on for your kids.";
  if (/is this free/i.test(words)) return 'The price is on villagehale.com.';
  if (/tell me a joke/i.test(words)) return "I'm not much of a comic.";
  if (/privacy|private/i.test(words))
    return 'I only keep what you send, and you can ask what I have.';
  if (/weather|recipe/i.test(words)) return "That's outside what I do.";
  if (/^(ok|lol|and|thanks)$/i.test(words) || /what's next/i.test(words)) return 'Got it.';
  if (/\b10001\b/.test(words) || /\bchicago\b/i.test(words)) {
    return 'I only cover the Toronto area right now.';
  }
  return null;
}

/**
 * Stand-in for the onboarding model. Production does not parse the message;
 * this fake does, so the tests can drive the order with plain texts. The ask
 * it writes follows ONBOARDING_ORDER from what the checklist and its own
 * capture say is known: postal, kids, ages, the map (no question), the name,
 * Gmail, calendar, schedule, co-parent.
 */
export function scriptedTurn(input: FriendVoiceInput): {
  reply: string;
  capture: OnboardingCapture;
  groupLeads?: string[];
} {
  const words = input.parentWords.trim();
  const capture: OnboardingCapture = {
    ...EMPTY_ONBOARDING_CAPTURE,
    children: [],
    scheduleAdds: [],
  };
  const postal = words.match(
    /\b([ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z])(?:[ -]?(\d[ABCEGHJ-NPRSTV-Z]\d))?\b/i,
  );
  if (postal?.[1]) {
    capture.postalCode = (postal[2] ? `${postal[1]} ${postal[2]}` : postal[1]).toUpperCase();
  }
  const months = [...words.matchAll(/\b([A-Z][a-z]+)\s+is\s+(\d{1,3})\s+months\b/g)];
  const named = [...words.matchAll(/\b([A-Z][a-z]+)\s+is\s+(\d{1,2})\b(?!\s+months)/g)];
  if (named.length > 0) {
    capture.children = named.map((match) => ({
      name: match[1] ?? null,
      ageMonths: Number(match[2]) * 12,
      agePrecision: 'years' as const,
    }));
  }
  if (months.length > 0) {
    capture.children = capture.children.concat(
      months.map((match) => ({
        name: match[1] ?? null,
        ageMonths: Number(match[2]),
        agePrecision: 'months' as const,
      })),
    );
  }
  const bareNames = words.match(/^([A-Z][a-z]+)(?:\s+and\s+([A-Z][a-z]+))?$/);
  if (bareNames?.[1] && input.step === 'kids_names') {
    capture.children = [bareNames[1], bareNames[2]]
      .filter((name): name is string => Boolean(name))
      .map((name) => ({ name, ageMonths: null, agePrecision: null }));
  }
  const called = words.match(/\bI'm\s+([A-Z][a-z]+)\b/);
  if (called?.[1]) capture.parentName = called[1];
  if (/^dana$/i.test(words)) capture.parentName = 'Dana';
  if (/\bI'm (his|her|their) dad\b/i.test(words)) {
    capture.parentRole = { role: 'father', basis: 'stated' };
  } else if (capture.parentName === 'Dana') {
    capture.parentRole = { role: 'unknown', basis: 'guessed' };
  }
  const actually = words.match(/\bactually\s+(\d{1,2})\b/i);
  if (actually?.[1]) {
    capture.children = [{ name: null, ageMonths: Number(actually[1]) * 12, agePrecision: 'years' }];
  }
  if (/\b10001\b/.test(words)) capture.postalCode = '10001';
  if (/\bchicago\b/i.test(words)) capture.city = 'Chicago';
  if (/\bcheck my calendar\b/i.test(words)) capture.connectCalendar = true;
  if (/\bwatch my email\b/i.test(words)) capture.connectGmail = true;
  if (/^(yes|yeah|yep)$/i.test(words)) {
    if (input.step === 'calendar') capture.connectCalendar = true;
    if (input.step === 'email') capture.connectGmail = true;
    if (input.step === 'coparent') capture.coparentGroup = true;
    if (
      input.step === 'schedule' &&
      input.findLines.length > 0 &&
      (input.scheduled ?? []).length === 0
    ) {
      capture.scheduleAdds = [
        { line: 1, cadence: 'weekly', date: '2026-08-01', time: null, weeks: null },
      ];
    }
  }
  // The reminders are confirmed; the next plain reply closes the schedule.
  if (input.step === 'schedule' && (input.scheduled ?? []).length > 0) capture.scheduleDone = true;
  if (/^(no|nope)$/i.test(words)) {
    if (input.step === 'names' || input.step === 'name_confirm') capture.nameDeclined = true;
    if (input.step === 'kids_names') capture.kidsNamesDeclined = true;
    if (input.step === 'calendar') capture.connectCalendar = false;
    if (input.step === 'email') capture.connectGmail = false;
    if (input.step === 'schedule') capture.scheduleDone = true;
    if (input.step === 'coparent') capture.coparentGroup = false;
  }
  if (/^later$/i.test(words)) {
    if (input.step === 'names') capture.nameDeclined = true;
    if (input.step === 'calendar') capture.calendarLater = true;
    if (input.step === 'email') capture.gmailLater = true;
  }

  const postalKnown =
    (Boolean(capture.postalCode) && capture.postalCode !== '10001') ||
    Boolean(input.placeLabel) ||
    input.checklist?.postal === true;
  const kidsKnown =
    capture.children.some((child) => child.name) ||
    capture.kidsNamesDeclined ||
    input.checklist?.kids === true;
  const capturedAges = capture.children.filter((child) => child.ageMonths != null);
  const agesKnown =
    (capture.children.length > 0 &&
      capturedAges.length === capture.children.length &&
      capturedAges.length > 0) ||
    input.ageMonths.length > 0 ||
    input.checklist?.ages === true;
  const nameKnown =
    Boolean(capture.parentName) ||
    capture.nameDeclined ||
    Boolean(input.parentName) ||
    input.checklist?.name === true;
  const gmailKnown =
    capture.connectGmail != null || capture.gmailLater || input.checklist?.gmail === true;
  const calendarKnown =
    capture.connectCalendar != null || capture.calendarLater || input.checklist?.calendar === true;
  const scheduleKnown = capture.scheduleDone || input.checklist?.schedule === true;
  const coparentKnown = capture.coparentGroup != null || input.checklist?.coparent === true;
  const name = capture.parentName ?? input.parentName;

  if (input.step === 'find_show') {
    return { reply: 'Here is what is on near you for their ages.', capture, groupLeads: [] };
  }
  // Reminders just recorded: confirm them, ask nothing.
  if (capture.scheduleAdds.length > 0) {
    return { reply: 'Done, a weekly reminder for the first one.', capture };
  }
  if (input.step === 'help') {
    const missing =
      input.checklist?.postal === false || !input.placeLabel ? 'postal code' : 'next step';
    return {
      reply: `I find what's on for your kids. You're on the ${missing}. Want to keep going?`,
      capture,
    };
  }
  if (input.step === 'nudge_find') {
    return { reply: 'Still here if one of those looks good. What should I call you?', capture };
  }
  // A yes to the connector just asked: the receipt for the yes, nothing more.
  // The next ask rides the connect receipt (connected-notice.ts) or the next text.
  if (
    (input.step === 'email' && capture.connectGmail === true && !input.checklist?.gmail) ||
    (input.step === 'calendar' && capture.connectCalendar === true && !input.checklist?.calendar)
  ) {
    return {
      reply:
        "Great, the link is right there. Tap it when you're ready and I'll text you what I see.",
      capture,
    };
  }

  let ask: string;
  if (input.language === 'fr' && !postalKnown) {
    ask = "Salut, c'est Hale. Quel est ton code postal?";
  } else if (input.language === 'fr' && !kidsKnown) {
    ask = "Comment s'appellent tes enfants?";
  } else if (input.language === 'fr' && !agesKnown) {
    ask = 'Quel âge ont les enfants?';
  } else if (!postalKnown) {
    ask = input.introduce ? "Hey, it's Hale. What's your postal code?" : "What's your postal code?";
  } else if (!kidsKnown) {
    ask = "What are your kids' names?";
  } else if (!agesKnown) {
    ask = 'How old are your kids?';
  } else if (!nameKnown) {
    ask = 'What should I call you?';
  } else if (!gmailKnown) {
    ask = name
      ? `${name}, want me to watch school and camp email for the dates?`
      : 'Want me to watch school and camp email for the dates?';
  } else if (!calendarKnown) {
    ask = name ? `${name}, want me to check your calendar?` : 'Want me to check your calendar?';
  } else if (!scheduleKnown && input.findLines.length > 0) {
    ask = 'Want the first one on your calendar as a weekly reminder?';
  } else if (!coparentKnown) {
    ask = 'Want me to set up a group chat with the other parent?';
  } else {
    return { reply: offScriptAside(words) ?? 'All set.', capture };
  }
  const aside = offScriptAside(words);
  const reply = aside ? `${aside} ${ask}` : ask;
  return { reply, capture };
}

/** The scripted turn on the composer's wire shape (role as two flat strings). */
export const scriptedFriendVoice: FriendVoiceComposer = {
  async compose(input: FriendVoiceInput) {
    const { capture, ...rest } = scriptedTurn(input);
    const { parentRole, ...fields } = capture;
    return {
      ...rest,
      capture: {
        ...fields,
        parentRole: parentRole?.role ?? null,
        parentRoleBasis: parentRole?.basis ?? null,
      },
    };
  },
};
