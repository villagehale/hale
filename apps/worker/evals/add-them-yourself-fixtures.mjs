// The add-them-yourself reply — the corpus.
//
// Expectations come from the SPEC (packages/agent/skills/group-onboarding-voice.md, kind
// `add_them_yourself`), not from what the model happened to write. A parent typed "add
// <name> <number> as <role>"; Hale texts nobody first, so the reply says how that person
// gets in. There is no fixed line under it: a reply the composer's gates refuse twice is
// a parent who hears nothing.
//
// The grid is the one the composer's facts span: en/fr x sms/imessage x a name given or
// not. iMessage must name the group; a given name must appear; every reply must carry no
// digit, no link, and no claim that Hale texted, invited or added anyone.

export const ADD_THEM_YOURSELF_FIXTURES = [
  {
    id: 'en-sms-named-co-parent',
    request: { language: 'en', name: 'Sam', role: 'co_parent', channel: 'sms' },
    watchFor:
      'SMS has no group: Sam texts Hale here themselves. Names Sam. No promise that Hale will text, invite or add Sam.',
  },
  {
    id: 'en-sms-unnamed',
    request: { language: 'en', name: null, role: null, channel: 'sms' },
    watchFor:
      'The request did not read: no name, no role. The person texts Hale themselves. Must not invent a name or a role.',
  },
  {
    id: 'en-imessage-named-grandparent',
    request: { language: 'en', name: 'Nana', role: 'grandparent', channel: 'imessage' },
    watchFor:
      'Names Nana. The parent adds Nana to the family group chat with Hale in it, or Nana texts Hale. Must not explain what a grandparent can see.',
  },
  {
    id: 'en-imessage-unnamed-nanny',
    request: { language: 'en', name: null, role: 'nanny', channel: 'imessage' },
    watchFor:
      'No name given, so none is invented. Mentions the family group as the way in, or the nanny texting Hale.',
  },
  {
    id: 'fr-sms-named-co-parent',
    request: { language: 'fr', name: 'Alex', role: 'co_parent', channel: 'sms' },
    watchFor:
      'French with real accents, tu. Names Alex. Alex écrit à Hale ici. No promise that Hale will write to Alex.',
  },
  {
    id: 'fr-sms-unnamed',
    request: { language: 'fr', name: null, role: null, channel: 'sms' },
    watchFor:
      'French with real accents, tu. No name and no role invented. The person writes to Hale themselves.',
  },
  {
    id: 'fr-imessage-named-babysitter',
    request: { language: 'fr', name: 'Jo', role: 'babysitter', channel: 'imessage' },
    watchFor:
      'French with real accents, tu. Names Jo. Le groupe de la famille avec Hale dedans, or Jo writes to Hale.',
  },
  {
    id: 'fr-imessage-unnamed-grandparent',
    request: { language: 'fr', name: null, role: 'grandparent', channel: 'imessage' },
    watchFor: 'French with real accents, tu. Mentions the group as the way in. No invented name.',
  },
];
