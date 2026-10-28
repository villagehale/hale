// VIL-102 — meaning corpus for the group RSVP reader. Synthetic names only.
// Scoring is the intent label, never a word in the message.

const HALE = ['Hale'];
const NOW = '2026-10-10T18:00:00.000Z';

export const GROUP_RSVP_READ_FIXTURES = [
  {
    id: 'en-track-any-words',
    input: {
      text: 'can you keep a running count of who is coming to Maya’s party Saturday at the park?',
      tapback: null,
      senderName: 'Priya',
      haleNames: HALE,
      tracking: false,
      now: NOW,
      recent: [],
    },
    accept: ['track'],
  },
  {
    id: 'en-report',
    input: {
      text: 'where are we at on that?',
      tapback: null,
      senderName: 'Dana',
      haleNames: HALE,
      tracking: true,
      now: NOW,
      recent: [
        { from: 'member', text: 'Hale keep track of who is coming Saturday' },
        { from: 'hale', text: 'I am keeping the count for Saturday.' },
      ],
    },
    accept: ['report'],
  },
  {
    id: 'en-yes-plain',
    input: {
      text: 'we will be there',
      tapback: null,
      senderName: 'Jordan',
      haleNames: HALE,
      tracking: true,
      now: NOW,
      recent: [],
    },
    accept: ['yes'],
  },
  {
    id: 'en-no-plain',
    input: {
      text: 'we cannot make it',
      tapback: null,
      senderName: 'Sam',
      haleNames: HALE,
      tracking: true,
      now: NOW,
      recent: [],
    },
    accept: ['no'],
  },
  {
    id: 'en-chips-chatter',
    input: {
      text: 'anyone bringing chips?',
      tapback: null,
      senderName: 'Jordan',
      haleNames: HALE,
      tracking: true,
      now: NOW,
      recent: [],
    },
    accept: ['chatter'],
  },
  {
    id: 'en-like-tapback',
    input: {
      text: '',
      tapback: 'like',
      senderName: 'Priya',
      haleNames: HALE,
      tracking: true,
      now: NOW,
      recent: [{ from: 'member', text: 'who is coming Saturday' }],
    },
    accept: ['yes'],
  },
  {
    id: 'fr-track',
    input: {
      text: 'Hale tu peux noter qui vient à la fête de Maya samedi?',
      tapback: null,
      senderName: 'Camille',
      haleNames: HALE,
      tracking: false,
      now: NOW,
      recent: [],
    },
    accept: ['track'],
  },
];
