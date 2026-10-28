// Fixtures for evals/group-reminder-eval.mjs (VIL-448 · T26, "Remind me ..." from anyone in
// the family group). Every family, name and phone here is invented; nothing is a real family.
//
// A case is one message in a family group. `expect` is what a correct read means, as data:
// the request, and for each reminder who it is for, the moment it was asked for (compared
// as an instant, so "today at 5:30" and a bare "5:30" are the same answer) and where it was
// asked to go. Code checks only those fields and the delivery the real planner derives from
// them. Whether the texts carry the facts, in the right language and register, is the
// judge's call against `confirmMustSay` / `reminderMustSay` — no word in any text is checked.

/** Wednesday 2026-10-28, 14:00 in Toronto. */
export const GROUP_REMINDER_NOW = '2026-10-28T18:00:00.000Z';

const ONTARIO_QUIET = { start: '21:00', end: '08:00' };

export const GROUP_REMINDER_HOUSEHOLDS = {
  // Priya signed up; Dan (co-parent) and her mother Ruth are in the family group only.
  shah: {
    timeZone: 'America/Toronto',
    language: 'en',
    groupQuiet: [ONTARIO_QUIET],
    seats: [
      {
        userId: 'u-priya',
        phoneHash: 'h-priya',
        firstName: 'Priya',
        haleCustomer: true,
        directReachable: true,
        directQuiet: [ONTARIO_QUIET, { start: '21:30:00', end: '07:30:00' }],
      },
      { userId: 'u-dan', phoneHash: 'h-dan', firstName: 'Dan', haleCustomer: false },
      { userId: 'u-ruth', phoneHash: 'h-ruth', firstName: 'Ruth', haleCustomer: false },
    ],
  },
  // Grace signed up. Her brother and her brother-in-law are both Sam, both group only.
  okafor: {
    timeZone: 'America/Toronto',
    language: 'en',
    groupQuiet: [ONTARIO_QUIET],
    seats: [
      {
        userId: 'u-grace',
        phoneHash: 'h-grace',
        firstName: 'Grace',
        haleCustomer: true,
        directReachable: true,
        directQuiet: [ONTARIO_QUIET],
      },
      { userId: 'u-sam-o', phoneHash: 'h-sam-o', firstName: 'Sam', haleCustomer: false },
      { userId: 'u-sam-a', phoneHash: 'h-sam-a', firstName: 'Sam', haleCustomer: false },
    ],
  },
  // A Montréal family that writes in French. Jacqueline is the grandmother, group only.
  tremblay: {
    timeZone: 'America/Toronto',
    language: 'fr',
    groupQuiet: [ONTARIO_QUIET],
    seats: [
      {
        userId: 'u-sophie',
        phoneHash: 'h-sophie',
        firstName: 'Sophie',
        haleCustomer: true,
        directReachable: true,
        directQuiet: [ONTARIO_QUIET],
      },
      {
        userId: 'u-jacqueline',
        phoneHash: 'h-jacqueline',
        firstName: 'Jacqueline',
        haleCustomer: false,
      },
    ],
  },
};

function sender(what, date, time, where = ['unsaid', 'group']) {
  return { for: 'sender', name: null, what, date, time, inMinutes: null, where };
}

export const GROUP_REMINDER_FIXTURES = [
  {
    id: 'grandparent-own',
    household: 'shah',
    sender: 'Ruth',
    message: 'Hale can you remind me Thursday at 4 to grab Maya from swim?',
    expect: {
      request: 'reminders',
      language: 'en',
      set: [sender('grab Maya from swim', '2026-10-29', '16:00')],
      plan: [{ delivery: 'group', moved: null }],
    },
    confirmMustSay: [
      'Ruth will be reminded to pick Maya up from swim',
      'on Thursday at 4 PM',
    ],
    reminderMustSay: ['it speaks to Ruth by name', 'it reminds her to pick Maya up from swim'],
  },
  {
    id: 'grandparent-private',
    household: 'shah',
    sender: 'Ruth',
    message: 'Hale, text me privately tomorrow at 9am to call the dentist about Maya',
    expect: {
      request: 'reminders',
      language: 'en',
      set: [sender('call the dentist about Maya', '2026-10-29', '09:00', ['private'])],
      plan: [{ delivery: 'group', moved: null }],
    },
    confirmMustSay: [
      'Ruth will be reminded tomorrow (Thursday) at 9 AM to call the dentist about Maya',
      'kindly, that it will be posted here in the group chat rather than sent privately',
      'it does not promise or imply a private text',
      'it makes no false privacy or scope claim: nothing like Hale cannot send private texts, and no reason why it is posted here',
    ],
    reminderMustSay: ['it speaks to Ruth by name', 'it reminds her to call the dentist about Maya'],
  },
  {
    id: 'remind-dan',
    household: 'shah',
    sender: 'Priya',
    message: 'Hale remind Dan at 5:30 today to pick up the birthday cake',
    expect: {
      request: 'reminders',
      language: 'en',
      set: [
        {
          for: 'person',
          name: 'Dan',
          what: 'pick up the birthday cake',
          date: '2026-10-28',
          time: '17:30',
          inMinutes: null,
          where: ['unsaid', 'group'],
        },
      ],
      plan: [{ delivery: 'group', moved: null, forUser: 'u-dan' }],
    },
    confirmMustSay: [
      'Dan will be reminded to pick up the birthday cake',
      'today at 5:30 PM',
    ],
    reminderMustSay: [
      'it speaks to Dan by name',
      'it reminds him to pick up the birthday cake',
      'if it says who asked, that is Priya',
    ],
  },
  {
    // Jordan is not in this chat: nobody seated has the name, so nothing is set.
    id: 'not-in-chat',
    household: 'shah',
    sender: 'Priya',
    message: 'Hale remind Jordan at 5 today to drop off the car seat',
    expect: {
      request: 'reminders',
      language: 'en',
      set: [
        {
          for: 'person',
          name: 'Jordan',
          what: 'drop off the car seat',
          date: '2026-10-28',
          time: '17:00',
          inMinutes: null,
          where: ['unsaid', 'group'],
        },
      ],
      plan: [],
      notSet: 1,
    },
    confirmMustSay: [
      'no reminder was set for Jordan to drop off the car seat',
      'that is because Hale can only remind people who are in this chat',
      'it does not say or imply that Jordan will be reminded some other way',
    ],
  },
  {
    // Two people in this chat are called Sam, so the reminder cannot be tied to one seat.
    id: 'name-shared',
    household: 'okafor',
    sender: 'Grace',
    message: 'Hale remind Sam tomorrow at 6 to bring the folding chairs',
    expect: {
      request: 'reminders',
      language: 'en',
      set: [
        {
          for: 'person',
          name: 'Sam',
          what: 'bring the folding chairs',
          date: '2026-10-29',
          time: '18:00',
          inMinutes: null,
          where: ['unsaid', 'group'],
        },
      ],
      plan: [],
      notSet: 1,
    },
    confirmMustSay: [
      'no reminder was set for Sam to bring the folding chairs',
      'that is because more than one person in this chat is called Sam, so Hale did not guess',
      'it does not say a reminder is set, and does not suggest Sam will be reached some other way',
    ],
  },
  {
    id: 'quiet-hours',
    household: 'shah',
    sender: 'Ruth',
    message: 'Hale remind me tonight at 10:30 to put the bins out',
    expect: {
      request: 'reminders',
      language: 'en',
      set: [sender('put the bins out', '2026-10-28', '22:30')],
      plan: [{ delivery: 'group', moved: 'earlier' }],
    },
    confirmMustSay: [
      'Ruth will be reminded to put the bins out',
      'the 10:30 PM she asked for falls in quiet hours, when Hale does not text',
      'so it will go out tonight at 8:45 PM instead',
    ],
    reminderMustSay: [
      'it speaks to Ruth by name',
      'it reminds her to put the bins out',
      'if it mentions timing, it may say the 10:30 PM she asked for falls in quiet hours and that it went out earlier because of that; it must not present 10:30 PM as the time it is going out, or state that quiet hours start at 10:30 PM',
    ],
  },
  {
    id: 'stop-before-fire',
    household: 'shah',
    sender: 'Ruth',
    message: 'Hale remind me tomorrow at 3 to bring the snacks for practice',
    expect: {
      request: 'reminders',
      language: 'en',
      set: [sender('bring the snacks for practice', '2026-10-29', '15:00')],
      plan: [{ delivery: 'group', moved: null }],
    },
    // Ruth texts STOP in the group before it is due: her seat is gone at fire time.
    fire: { askerSeated: false, expectDrop: 'asker_gone' },
    confirmMustSay: [
      'Ruth will be reminded tomorrow (Thursday) at 3 PM to bring the snacks for practice',
    ],
  },
  {
    id: 'french',
    household: 'tremblay',
    sender: 'Jacqueline',
    message: "Hale, rappelle-moi jeudi à 16 h d'aller chercher Léo à la natation",
    expect: {
      request: 'reminders',
      language: 'fr',
      set: [sender('aller chercher Léo à la natation', '2026-10-29', '16:00')],
      plan: [{ delivery: 'group', moved: null }],
    },
    confirmMustSay: [
      'written in French, in a tone that fits a message the whole group reads',
      'Jacqueline will be reminded to pick Léo up from swimming',
      'on Thursday at 16 h (4 PM)',
    ],
    reminderMustSay: [
      'written in French, in a tone that fits a message the whole group reads',
      'it speaks to Jacqueline by name',
      'it reminds her to pick Léo up from swimming',
    ],
  },
  {
    id: 'customer-direct',
    household: 'shah',
    sender: 'Priya',
    message: "Hale remind me tomorrow at 3pm to book Maya's dentist",
    expect: {
      request: 'reminders',
      language: 'en',
      set: [sender("book Maya's dentist", '2026-10-29', '15:00')],
      plan: [{ delivery: 'direct', moved: null }],
    },
    confirmMustSay: [
      "Priya will be reminded to book Maya's dentist appointment",
      'tomorrow (Thursday) at 3 PM',
      'it will come to her as her own text from Hale, not in the group',
    ],
    reminderMustSay: [
      'it is a one-to-one text to Priya, so it needs no name',
      "it reminds her to book Maya's dentist appointment",
    ],
  },
  {
    id: 'needs-time',
    household: 'shah',
    sender: 'Ruth',
    message: 'Hale can you remind me to bring the orange slices?',
    expect: {
      request: 'reminders',
      language: 'en',
      set: [sender('bring the orange slices', null, null)],
      plan: [],
      needsTime: 1,
    },
    confirmMustSay: [
      'it asks Ruth when she would like the reminder to bring the orange slices',
      'that is the only question, and nothing is said to be set yet',
    ],
  },
  {
    id: 'cancel',
    household: 'shah',
    sender: 'Ruth',
    message: "Hale never mind the swim reminder, Priya's getting her",
    open: [
      {
        ref: 'r1',
        rowId: 'row-swim',
        for: 'sender',
        what: 'grab Maya from swim',
        deliverAt: '2026-10-29T20:00:00.000Z',
      },
    ],
    expect: { request: 'reminders', language: 'en', set: [], cancel: ['r1'], plan: [] },
    confirmMustSay: [
      'the reminder to grab Maya from swim is cancelled',
      'it does not say anything new was set',
    ],
  },
  {
    id: 'everyone',
    household: 'shah',
    sender: 'Priya',
    message: "Hale remind everyone Friday at 6 that dinner is at Ruth's",
    expect: {
      request: 'reminders',
      language: 'en',
      set: [
        {
          for: 'everyone',
          name: null,
          what: "dinner is at Ruth's",
          date: '2026-10-30',
          time: '18:00',
          inMinutes: null,
          where: ['unsaid', 'group'],
        },
      ],
      plan: [{ delivery: 'group', moved: null }],
    },
    confirmMustSay: [
      "everyone in the chat will be reminded that dinner is at Ruth's",
      'on Friday at 6 PM',
    ],
    reminderMustSay: [
      'it speaks to everyone in the chat, not one person',
      "it says dinner is at Ruth's",
      'if it says who asked, that is Priya',
    ],
  },
  {
    id: 'answer-to-hale',
    household: 'shah',
    sender: 'Ruth',
    recent: [
      { from: 'member', text: 'Hale remind me to call the pharmacy about the refill' },
      { from: 'hale', text: 'Happy to, Ruth. When would you like me to remind you?' },
    ],
    message: 'tomorrow at 10 please',
    expect: {
      request: 'reminders',
      language: 'en',
      set: [sender('call the pharmacy about the refill', '2026-10-29', '10:00')],
      plan: [{ delivery: 'group', moved: null }],
    },
    confirmMustSay: [
      'Ruth will be reminded to call the pharmacy about the refill',
      'tomorrow (Thursday) at 10 AM',
    ],
    reminderMustSay: [
      'it speaks to Ruth by name',
      'it reminds her to call the pharmacy about the refill',
    ],
  },
  {
    id: 'not-a-reminder',
    household: 'shah',
    sender: 'Priya',
    message: 'Hale is swim still on tomorrow?',
    expect: { request: 'other' },
  },
  {
    id: 'mixed',
    household: 'shah',
    sender: 'Ruth',
    message: 'Hale remind me at 4 to grab Maya, and what time does soccer start Saturday?',
    expect: { request: 'other' },
  },
];
