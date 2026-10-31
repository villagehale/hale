/**
 * Words a parent uses to undo or cancel, not to name themselves.
 *
 * The clear set is the one duty undo already treats as "take that back"
 * (`readDutyUndo`). Cancel is the same intent on a pending ask. A question is
 * not this phrase: "undo?" is something else.
 */

const DUTY_CLEAR = /^(undo|nvm|nm|never mind|nevermind|scratch that)$/;
const CANCEL = /^(cancel|canceled|cancelled)$/;

/** The phrase duty undo and the name capture both recognize, or empty. */
export function controlLine(text: string): string {
  if (text.includes('?')) return '';
  return text
    .trim()
    .replace(/[’]/g, "'")
    .replace(/\s+/g, ' ')
    .replace(/[.!]+$/u, '')
    .toLowerCase();
}

/** The whole message is one of the phrases duty undo already clears. */
export function isDutyClearPhrase(text: string): boolean {
  const line = controlLine(text);
  return line.length > 0 && DUTY_CLEAR.test(line);
}

/**
 * The whole message undoes or cancels. Duty's clear phrases, plus cancel.
 * Not a substring: "my name is Dana" is not this.
 */
export function isUndoCancelPhrase(text: string): boolean {
  const line = controlLine(text);
  return line.length > 0 && (DUTY_CLEAR.test(line) || CANCEL.test(line));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** English and French ways a reply addresses someone by a name. */
const NAME_ADDRESS =
  "call you|name is|name's|t['’]appellerai|t['’]appeler|t['’]appelle[rs]?|vous appelle[zr]?";

/**
 * The reply addresses the parent by the control word ("I'll call you undo",
 * `I'll call you "undo"`, "Je t'appelle undo"). Saying the word as an action
 * ("I'll undo that") is not this.
 */
export function replyUsesControlAsName(reply: string, parentWords: string): boolean {
  const line = controlLine(parentWords);
  if (!line || !isUndoCancelPhrase(parentWords)) return false;
  const quoted = `["“'«]*\\s*${escapeRegExp(line)}\\s*["”'»]*`;
  const called = new RegExp(`\\b(?:${NAME_ADDRESS})\\s+${quoted}(?![\\p{L}\\p{M}])`, 'iu');
  return called.test(reply);
}
