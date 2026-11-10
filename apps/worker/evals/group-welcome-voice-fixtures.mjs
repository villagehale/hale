// The new-member group welcome — the corpus (VIL-438, `member_welcome`).
//
// Expectations come from the copy facts handed to the model (group-onboarding-line-input.ts):
// who added Hale, that Hale sees only this chat, that nobody else has to sign up because one
// family's plan covers the whole group, and that anyone can stop it for themselves in any
// wording. There is no fixed copy and no word gate: the judge reads the facts and the tone.

export const GROUP_WELCOME_VOICE_FIXTURES = [
  {
    id: 'en-named-adder',
    request: { kind: 'member_welcome', adderName: 'Maya' },
    language: 'en',
    watchFor: 'Says Maya added Hale. Written to the whole group. No invented child, date or plan.',
  },
  {
    id: 'en-unknown-adder',
    request: { kind: 'member_welcome', adderName: null },
    language: 'en',
    watchFor:
      'No adder name is known, so none may be invented; "someone in the family" or similar is right.',
  },
  {
    id: 'fr-named-adder',
    request: { kind: 'member_welcome', adderName: 'Camille' },
    language: 'fr',
    watchFor: 'French, vous throughout (never tu), real accents. Says Camille added Hale.',
  },
  {
    id: 'zh-named-adder',
    request: { kind: 'member_welcome', adderName: '婷' },
    language: 'zh',
    watchFor:
      'Written in Chinese. Says 婷 added Hale, addressed to the whole group. No English sentences.',
  },
  {
    id: 'ja-named-adder',
    request: { kind: 'member_welcome', adderName: '由美' },
    language: 'ja',
    watchFor:
      'Written in Japanese. Says 由美 added Hale, addressed to the whole group, polite register.',
  },
];
