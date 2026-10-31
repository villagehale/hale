/**
 * Take-back during the open name ask. The model leaves `parentName` empty.
 * These strings are the cases, not a matcher: code does not decide intent from them.
 */
export const NAME_TAKEBACK_FIXTURES = [
  { id: 'undo', parentWords: 'undo' },
  { id: 'undo-capital', parentWords: 'Undo' },
  { id: 'nvm', parentWords: 'nvm' },
  { id: 'laisse-tomber', parentWords: 'laisse tomber' },
  { id: 'suanle', parentWords: '算了' },
];

/** The stored field after a take-back. Empty means nothing to write. */
export function parentNameLeftEmpty(parentName) {
  return parentName == null || String(parentName).trim() === '';
}
