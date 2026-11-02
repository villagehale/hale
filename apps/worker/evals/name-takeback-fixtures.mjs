/**
 * The open name ask. These strings are the cases, not a matcher: code does
 * not decide intent from them.
 *
 * A take-back leaves `parentName` empty and `nameDeclined` false: the name
 * stays open. "Dana" is a name. A question is neither. A real refusal to
 * give a name sets `nameDeclined`.
 */
export const NAME_TAKEBACK_FIXTURES = [
  { id: 'undo', parentWords: 'undo', expect: { parentName: '', nameDeclined: false } },
  { id: 'undo-capital', parentWords: 'Undo', expect: { parentName: '', nameDeclined: false } },
  { id: 'nvm', parentWords: 'nvm', expect: { parentName: '', nameDeclined: false } },
  {
    id: 'laisse-tomber',
    parentWords: 'laisse tomber',
    expect: { parentName: '', nameDeclined: false },
  },
  { id: 'suanle', parentWords: '算了', expect: { parentName: '', nameDeclined: false } },
  { id: 'dana', parentWords: 'Dana', expect: { parentName: 'Dana' } },
  {
    id: 'question',
    parentWords: 'what time is the storytime on Saturday?',
    expect: { parentName: '', nameDeclined: false },
  },
  {
    id: 'rather-not',
    parentWords: "I'd rather not give my name",
    expect: { parentName: '', nameDeclined: true },
  },
];

/** The stored field after a take-back. Empty means nothing to write. */
export function parentNameLeftEmpty(parentName) {
  return parentName == null || String(parentName).trim() === '';
}

/** What this fixture requires of the model's tool value. */
export function nameTakebackMatches(fixture, value) {
  const parentName = value?.parentName ?? null;
  const want = fixture.expect.parentName;
  const nameOk =
    want === ''
      ? parentNameLeftEmpty(parentName)
      : String(parentName ?? '')
          .trim()
          .toLowerCase() === want.toLowerCase();
  if (!nameOk) return false;
  if (fixture.expect.nameDeclined === false && value?.nameDeclined === true) return false;
  if (fixture.expect.nameDeclined === true && value?.nameDeclined !== true) return false;
  return true;
}
