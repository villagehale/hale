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
      plan: null,
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
      plan: {
        title: "ROM Saturday",
        deadline: "Friday",
        yesNames: [],
        waitingNames: ["Maya", "Wei", "Sam"],
      },
      recent: [],
    },
    accept: ["rsvp"],
    samePlan: true,
  },
  {
    id: "edit-no",
    situation: "Someone who already said yes changes their mind.",
    input: {
      text: "actually we cannot make it",
      tapback: null,
      senderName: "Maya",
      plan: {
        title: "Saturday picnic",
        deadline: null,
        yesNames: ["Maya"],
        waitingNames: ["Sam"],
      },
      recent: [],
    },
    accept: ["edit", "rsvp"],
    samePlan: true,
  },
  {
    id: "ask-count",
    situation: "Someone wants the live yes / no / waiting picture.",
    input: {
      text: "where do we stand",
      tapback: null,
      senderName: "Priya",
      plan: {
        title: "Saturday picnic",
        deadline: null,
        yesNames: ["Sam"],
        waitingNames: ["Maya"],
      },
      recent: [],
    },
    accept: ["ask_tally"],
    samePlan: true,
  },
  {
    id: "banter",
    situation: "People joking with each other. Not a vote and not an ask.",
    input: {
      text: "lol remember last time with the wasps",
      tapback: null,
      senderName: "Maya",
      plan: {
        title: "Saturday picnic",
        deadline: null,
        yesNames: ["Sam"],
        waitingNames: ["Maya"],
      },
      recent: [],
    },
    accept: ["chatter"],
  },
  {
    id: "other-event-opening",
    situation:
      "A picnic is being counted. A parent now asks Hale who is in for a zoo trip on Sunday at 2: a different event, not the picnic.",
    input: {
      text: "Hale who's in for the zoo Sunday at 2?",
      tapback: null,
      senderName: "Ada",
      plan: {
        title: "picnic",
        deadline: null,
        yesNames: ["Bao"],
        waitingNames: ["Ada"],
      },
      recent: [],
    },
    accept: ["start_tracking"],
    samePlan: false,
  },
  {
    id: "same-plan-opening",
    situation:
      "A Saturday picnic is already being counted. A parent asks Hale to count who is coming to that same picnic.",
    input: {
      text: "Hale can you count who's coming to the picnic?",
      tapback: null,
      senderName: "Ada",
      plan: {
        title: "Saturday picnic",
        deadline: null,
        yesNames: [],
        waitingNames: ["Ada", "Bao"],
      },
      recent: [],
    },
    accept: ["start_tracking", "ask_tally"],
    samePlan: true,
  },
  {
    id: "answer-other-event",
    situation:
      "A picnic is being counted. Someone says their family is in for the zoo on Sunday: an answer about a different event, not the picnic.",
    input: {
      text: "we're in for the zoo on Sunday",
      tapback: null,
      senderName: "Bao",
      plan: {
        title: "picnic",
        deadline: null,
        yesNames: [],
        waitingNames: ["Ada", "Bao"],
      },
      recent: [],
    },
    accept: ["rsvp", "start_tracking", "chatter"],
    samePlan: false,
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
];
