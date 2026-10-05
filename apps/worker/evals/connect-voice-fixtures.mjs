// The connect-by-text door — the corpus.
//
// Every word the door says to a parent — the link offer, the two-link offer, and the
// three ways a disconnect ends — is written by the model from real facts
// (packages/agent/skills/connect-voice.md). Until VIL-413 / VIL-417 this was
// connect/copy.ts: a locked offer with "Good for 15 minutes", a fixed Google
// "unverified app" caution glued in front of it, and three disconnect receipts. There is
// no fixed sentence underneath any of them now. What the model writes is what the parent
// reads, with the real link appended by code, or nothing goes out and #ops is paged. So the
// corpus is built around the two ways that fails.
//
//   · Every fixture must produce a line the REAL judge accepts
//     (apps/web/lib/channel/voice/judge.ts, loaded live): inside the length cap, no
//     question, the account name / minutes / Google button word carried word for word, no
//     URL (code appends the link), no keyword-reply or compliance wording, no claim that
//     Hale saw a password or changed anything on Google's side, tu with real accents in
//     French.
//
//   · Every fixture must also be the RIGHT line for the moment — the per-kind direction
//     in the skill, scored by the judge model with `watchFor` as the fixture's notes.
//
// `request` is the exact ConnectLineRequest the handlers build; `connectLineInput` (loaded
// live from apps/web/lib/channel/connect/line-input.ts) turns it into what the model sees,
// so a change to the facts a kind hands over re-keys the cache. `options.parentWords` is
// the parent's message when the line answers one.

export const CONNECT_VOICE_FIXTURES = [
  // ── offer ────────────────────────────────────────────────────────────────────
  {
    id: 'offer-gcal-en',
    language: 'en',
    request: { kind: 'offer', account: 'gcal' },
    options: { parentWords: 'can you connect my google calendar' },
    watchFor:
      'Hands over a link for Google Calendar: says "Google Calendar", that the link is good for 15 minutes, and that if Google warns about an unverified app they tap "Advanced" and carry on. Points at "this link" (code appends the URL). No URL of its own. No question. No "reply" anything. Under 220 characters.',
  },
  {
    id: 'offer-gmail-fr',
    language: 'fr',
    request: { kind: 'offer', account: 'gmail' },
    options: { parentWords: 'tu peux lire mon gmail pour les courriels de la garderie' },
    watchFor:
      'French, tu, real accents. Says "Gmail", that the link is good for 15 minutes, and that if Google warns they tap "Paramètres avancés" and continue. Uses relier/lier, not the verb connecter. Points at "ce lien". No URL. No question. Never vous.',
  },
  {
    id: 'offer-gdrive-en',
    language: 'en',
    request: { kind: 'offer', account: 'gdrive' },
    options: { parentWords: 'link my google drive please, the school forms are in there' },
    watchFor:
      'Says "Google Drive", 15 minutes, and the "Advanced" note. Does not promise anything about the forms or say what Hale will do with the files. No URL. No question.',
  },
  {
    id: 'offer-fresh-gcal-fr',
    language: 'fr',
    request: { kind: 'offer', account: 'gcal' },
    options: { parentWords: 'le lien a expiré' },
    watchFor:
      'The old link expired and the parent said so; this is a fresh one for "Google Agenda". French, tu, real accents (expiré, Paramètres avancés). Says 15 minutes and the Google warning note. Does not apologise at length and does not blame the parent. No URL. No question.',
  },

  // ── offer_both ───────────────────────────────────────────────────────────────
  {
    id: 'offer-both-en',
    language: 'en',
    request: { kind: 'offer_both', first: 'gcal', second: 'gmail' },
    options: { parentWords: 'connect my calendar and my gmail' },
    watchFor:
      'Two links follow, in order. Says the first is for "Google Calendar" and the second for "Gmail", both good for 15 minutes, and the "Advanced" note once. Carries both names. No URL. No question. Under 220 characters.',
  },
  {
    id: 'offer-both-fr',
    language: 'fr',
    request: { kind: 'offer_both', first: 'gmail', second: 'gdrive' },
    options: { parentWords: 'relie mon gmail et mon drive' },
    watchFor:
      'French, tu, real accents. First link for "Gmail", second for "Google Drive", both 15 minutes, "Paramètres avancés" if Google warns. Relier/lier, not connecter. No URL. No question.',
  },

  // ── revoked ──────────────────────────────────────────────────────────────────
  {
    id: 'revoked-gcal-en',
    language: 'en',
    request: { kind: 'revoked', account: 'gcal' },
    options: { parentWords: 'disconnect my google calendar' },
    watchFor:
      'Honest on both halves: "Google Calendar" is disconnected on Hale\'s side and Hale threw its keys away; Google still lists Hale on their account until they remove it themselves, and the link that follows is where they do that. Must NOT say Hale disconnected it "from Google", told Google, or removed itself from their Google account. No URL. No question.',
  },
  {
    id: 'revoked-gmail-fr',
    language: 'fr',
    request: { kind: 'revoked', account: 'gmail' },
    options: { parentWords: 'arrête de lire mon gmail' },
    watchFor:
      'French, tu, real accents (côté, clés, supprimé). "Gmail" is cut off on Hale\'s side, keys deleted; Google still lists Hale until they remove it themselves, via the link that follows. No claim of having changed anything at Google. No URL. No question.',
  },

  // ── not_connected ────────────────────────────────────────────────────────────
  {
    id: 'not-connected-gdrive-en',
    language: 'en',
    request: { kind: 'not_connected', account: 'gdrive' },
    options: { parentWords: 'unlink my drive' },
    watchFor:
      'Nothing to undo: no "Google Drive" of theirs is connected. Says that plainly, and that if they want it linked they can just ask here - in their own words, NEVER a word to type (no "reply CONNECT", no "say LINK"). No link follows. No question.',
  },
  {
    id: 'not-connected-gcal-fr',
    language: 'fr',
    request: { kind: 'not_connected', account: 'gcal' },
    options: { parentWords: 'déconnecte mon agenda' },
    watchFor:
      'French, tu, real accents. No "Google Agenda" is linked, so nothing to undo; they can just ask here if they want it linked. No keyword to type. No URL. No question.',
  },

  // ── revoke_failed / mint_failed ──────────────────────────────────────────────
  {
    id: 'revoke-failed-en',
    language: 'en',
    request: { kind: 'revoke_failed', account: 'gmail' },
    options: { parentWords: 'disconnect gmail' },
    watchFor:
      'Something went wrong at Hale\'s end disconnecting "Gmail"; nothing changed; they can try again in a minute. Short. Does not apologise at length, does not blame Google or the parent, does not invent a cause. No question.',
  },
  {
    id: 'mint-failed-fr',
    language: 'fr',
    request: { kind: 'mint_failed', account: 'gcal' },
    options: { parentWords: 'connecte mon agenda google' },
    watchFor:
      'French, tu, real accents. Hale could not make the link for "Google Agenda" just now; nothing has changed; asking again in a minute should work. No URL, no question, no keyword.',
  },
];
