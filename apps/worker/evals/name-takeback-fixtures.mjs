/**
 * The open name ask. These strings are the cases, not a matcher: code does
 * not decide intent from them.
 *
 * A take-back leaves `parentName` empty and `nameDeclined` false, and sets
 * `nameTakenBack`. "Dana" is a name. A question sets neither flag. A real
 * refusal sets `nameDeclined` and leaves `nameTakenBack` false.
 */
export const NAME_TAKEBACK_FIXTURES = [
  {
    id: 'undo',
    parentWords: 'undo',
    expect: { parentName: '', nameDeclined: false, nameTakenBack: true },
  },
  {
    id: 'undo-capital',
    parentWords: 'Undo',
    expect: { parentName: '', nameDeclined: false, nameTakenBack: true },
  },
  {
    id: 'nvm',
    parentWords: 'nvm',
    expect: { parentName: '', nameDeclined: false, nameTakenBack: true },
  },
  {
    id: 'laisse-tomber',
    parentWords: 'laisse tomber',
    expect: { parentName: '', nameDeclined: false, nameTakenBack: true },
  },
  {
    id: 'suanle',
    parentWords: '算了',
    expect: { parentName: '', nameDeclined: false, nameTakenBack: true },
  },
  {
    id: 'dana',
    parentWords: 'Dana',
    expect: { parentName: 'Dana', nameDeclined: false, nameTakenBack: false },
  },
  {
    id: 'question',
    parentWords: 'what time is the storytime on Saturday?',
    expect: { parentName: '', nameDeclined: false, nameTakenBack: false },
  },
  {
    id: 'rather-not',
    parentWords: "I'd rather not give my name",
    expect: { parentName: '', nameDeclined: true, nameTakenBack: false },
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
  if (
    'nameDeclined' in fixture.expect &&
    flagIs(value, 'nameDeclined') !== fixture.expect.nameDeclined
  ) {
    return false;
  }
  if (
    'nameTakenBack' in fixture.expect &&
    flagIs(value, 'nameTakenBack') !== fixture.expect.nameTakenBack
  ) {
    return false;
  }
  return true;
}

/** A missing flag is false. The schema defaults an omitted boolean that way. */
function flagIs(value, key) {
  return value?.[key] === true;
}
