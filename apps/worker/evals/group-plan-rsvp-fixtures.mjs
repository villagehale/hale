/**
 * VIL-442 (T15) judge cases. Meaning, not wording. A 1–5 score.
 *
 * The runner does not assert a phrase. The judge scores whether the reading
 * or the spoken line matches the situation.
 */

export const GROUP_PLAN_RSVP_READ_FIXTURES = [
  {
    id: "picnic-start",
    situation:
      "A parent asks Hale, in their own words, to keep count for a Saturday picnic.",
    input: {
      text: "Hale can you keep track of who is coming to the picnic Saturday?",
      tapback: null,
      senderName: "Priya",
      plans: [],
      recent: [],
    },
    accept: ["start_tracking"],
  },
  {
    id: "family-yes",
    situation:
      "A parent answers for their whole household on a live museum plan.",
    input: {
      text: "the Chens are in, all three of us",
      tapback: null,
      senderName: "Maya",
      plans: [
        {
          key: "p1",
          title: "ROM Saturday",
          startsAt: null,
          deadline: "Friday",
          yesNames: [],
          waitingNames: ["Maya", "Wei", "Sam"],
        },
      ],
      recent: [],
    },
    accept: ["rsvp"],
    planKey: "p1",
  },
  {
    id: "edit-no",
    situation: "Someone who already said yes changes their mind.",
    input: {
      text: "actually we cannot make it",
      tapback: null,
      senderName: "Maya",
      plans: [
        {
          key: "p1",
          title: "Saturday picnic",
          startsAt: null,
          deadline: null,
          yesNames: ["Maya"],
          waitingNames: ["Sam"],
        },
      ],
      recent: [],
    },
    accept: ["edit", "rsvp"],
    planKey: "p1",
  },
  {
    id: "ask-count",
    situation: "Someone wants the live yes / no / waiting picture.",
    input: {
      text: "where do we stand",
      tapback: null,
      senderName: "Priya",
      plans: [
        {
          key: "p1",
          title: "Saturday picnic",
          startsAt: null,
          deadline: null,
          yesNames: ["Sam"],
          waitingNames: ["Maya"],
        },
      ],
      recent: [],
    },
    accept: ["ask_tally"],
    planKey: "p1",
  },
  {
    id: "banter",
    situation: "People joking with each other. Not a vote and not an ask.",
    input: {
      text: "lol remember last time with the wasps",
      tapback: null,
      senderName: "Maya",
      plans: [
        {
          key: "p1",
          title: "Saturday picnic",
          startsAt: null,
          deadline: null,
          yesNames: ["Sam"],
          waitingNames: ["Maya"],
        },
      ],
      recent: [],
    },
    accept: ["chatter"],
  },
  {
    id: "other-event-opening",
    situation:
      "A picnic is being counted. A parent now asks Hale who is in for a zoo trip on Sunday at 2: a different event, not the picnic. Today is Thursday, November 12.",
    input: {
      text: "Hale who's in for the zoo Sunday at 2?",
      tapback: null,
      senderName: "Ada",
      plans: [
        {
          key: "p1",
          title: "picnic",
          startsAt: null,
          deadline: null,
          yesNames: ["Bao"],
          waitingNames: ["Ada"],
        },
      ],
      recent: [],
      clock: { now: "2026-11-12T11:00:00-05:00", timeZone: "America/Toronto" },
    },
    accept: ["start_tracking"],
    planKey: "other",
    startsAt: "2026-11-15T14:00:00-05:00",
  },
  {
    id: "same-plan-opening",
    situation:
      "A Saturday picnic is already being counted. A parent asks Hale to count who is coming to that same picnic.",
    input: {
      text: "Hale can you count who's coming to the picnic?",
      tapback: null,
      senderName: "Ada",
      plans: [
        {
          key: "p1",
          title: "Saturday picnic",
          startsAt: null,
          deadline: null,
          yesNames: [],
          waitingNames: ["Ada", "Bao"],
        },
      ],
      recent: [],
    },
    accept: ["start_tracking", "ask_tally"],
    planKey: "p1",
  },
  {
    id: "answer-other-event",
    situation:
      "A picnic is being counted. Someone says their family is in for the zoo on Sunday: an answer about a different event, not the picnic.",
    input: {
      text: "we're in for the zoo on Sunday",
      tapback: null,
      senderName: "Bao",
      plans: [
        {
          key: "p1",
          title: "picnic",
          startsAt: null,
          deadline: null,
          yesNames: [],
          waitingNames: ["Ada", "Bao"],
        },
      ],
      recent: [],
    },
    accept: ["rsvp", "start_tracking", "chatter"],
    planKey: "other",
  },
  {
    id: "late-answer-older-plan",
    situation:
      "Two plans are being counted: a zoo trip (newest) and a picnic. Someone answers for the picnic by name: it is about the picnic, not the zoo.",
    input: {
      text: "we're in for the picnic",
      tapback: null,
      senderName: "Bao",
      plans: [
        {
          key: "p1",
          title: "zoo",
          startsAt: "2026-11-15T14:00:00-05:00",
          deadline: null,
          yesNames: [],
          waitingNames: ["Ada", "Bao"],
        },
        {
          key: "p2",
          title: "picnic",
          startsAt: "2026-11-14T10:00:00-05:00",
          deadline: null,
          yesNames: ["Ada"],
          waitingNames: ["Bao"],
        },
      ],
      recent: [],
    },
    accept: ["rsvp"],
    planKey: "p2",
  },
  {
    id: "unclear-between-plans",
    situation:
      "Two plans are being counted: a zoo trip and a picnic. Someone tells Hale to count them in without saying which event: it could be either.",
    input: {
      text: "Hale count us in!",
      tapback: null,
      senderName: "Bao",
      plans: [
        {
          key: "p1",
          title: "zoo",
          startsAt: "2026-11-15T14:00:00-05:00",
          deadline: null,
          yesNames: [],
          waitingNames: ["Ada", "Bao"],
        },
        {
          key: "p2",
          title: "picnic",
          startsAt: "2026-11-14T10:00:00-05:00",
          deadline: null,
          yesNames: ["Ada"],
          waitingNames: ["Bao"],
        },
      ],
      recent: [],
    },
    accept: ["rsvp"],
    planKey: "unclear",
    addressed: true,
  },
  {
    id: "replaces-plan",
    situation:
      "A Saturday picnic is being counted. A parent tells Hale that rain is coming, so the group will do the zoo on Sunday at 2 instead of the picnic: a new event that replaces the picnic. Today is Thursday, November 12.",
    input: {
      text: "Hale it's going to rain Saturday, let's do the zoo Sunday at 2 instead of the picnic",
      tapback: null,
      senderName: "Ada",
      plans: [
        {
          key: "p1",
          title: "picnic",
          startsAt: "2026-11-14T10:00:00-05:00",
          deadline: null,
          yesNames: ["Bao"],
          waitingNames: ["Ada"],
        },
      ],
      recent: [],
      clock: { now: "2026-11-12T11:00:00-05:00", timeZone: "America/Toronto" },
    },
    accept: ["start_tracking"],
    planKey: "other",
    replacesPlanKey: "p1",
    startsAt: "2026-11-15T14:00:00-05:00",
  },
];

export const GROUP_PLAN_RSVP_VOICE_FIXTURES = [
  {
    id: "tracking-started",
    kind: "tracking_started",
    title: "Saturday picnic",
    deadline: null,
    rows: [],
    expected: [
      { memberKey: "priya", displayName: "Priya" },
      { memberKey: "sam", displayName: "Sam" },
      { memberKey: "maya", displayName: "Maya" },
    ],
    situation:
      "Hale just began counting a Saturday picnic. Facts: title Saturday picnic, waitingNames Priya Sam Maya, toGo 3. One question.",
    watchFor:
      "Must say it is counting this plan and name waiting people from facts. One ask. Must not invent a poll, a button, or a reply keyword.",
  },
  {
    id: "tally-report",
    kind: "tally",
    title: "Saturday picnic",
    deadline: "Friday",
    rows: [
      {
        memberKey: "priya",
        displayName: "Priya",
        response: "yes",
        headcount: 1,
        householdLabel: null,
        coversKeys: [],
      },
      {
        memberKey: "sam",
        displayName: "Sam",
        response: "yes",
        headcount: 1,
        householdLabel: null,
        coversKeys: [],
      },
      {
        memberKey: "maya",
        displayName: "Maya",
        response: "no",
        headcount: 1,
        householdLabel: null,
        coversKeys: [],
      },
    ],
    expected: [
      { memberKey: "priya", displayName: "Priya" },
      { memberKey: "sam", displayName: "Sam" },
      { memberKey: "maya", displayName: "Maya" },
      { memberKey: "dev", displayName: "Dev" },
    ],
    situation:
      "Hale is reporting the live count for a Saturday picnic. Facts: 2 yes (Priya, Sam), 1 no (Maya), 1 waiting (Dev), deadline Friday. No question.",
    watchFor:
      "Must carry the yes / no / waiting picture and the deadline from facts. Must not invent a calendar write, a poll, or a reply keyword.",
  },
  {
    id: "follow-up",
    kind: "follow_up",
    title: "soccer Saturday",
    deadline: null,
    rows: [],
    expected: [{ memberKey: "ben", displayName: "Ben" }],
    situation:
      "Hale is nudging the people still waiting on soccer Saturday. Facts: waitingNames Ben. One question.",
    watchFor:
      "Must name who is waiting from facts. One ask. Must not invent that Ben is free or busy.",
  },
  {
    id: "which-plan",
    kind: "which_plan",
    choices: [
      { title: "zoo", startsAt: "Sun, Nov 15 at 2:00 PM" },
      { title: "picnic", startsAt: "Sat, Nov 14 at 10:00 AM" },
    ],
    situation:
      "Someone told Hale to count them in, but two plans are open: the zoo and the picnic. Hale asks which one they mean. Facts: choices zoo (Sun, Nov 15 at 2:00 PM) and picnic (Sat, Nov 14 at 10:00 AM). One question.",
    watchFor:
      "Must ask which of the two plans, naming both. Must not say anyone was counted, must not tell people what to type or reply, and must not invent a time.",
  },
];
