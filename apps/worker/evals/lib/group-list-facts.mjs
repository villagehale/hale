/**
 * WHO DID WHAT THIS TURN, AS DATA (#918).
 *
 * The group-lists judge used to get only `before` and `after` snapshots plus the group
 * message as "First: text", so it had to diff the lists and parse the sender out of a
 * string to know who added what. This hands it the result directly: who sent the message,
 * and every item the turn added, checked off, or found already on, each with its list and
 * the name of the person who added it. Computed from item ids only: no text matching.
 */

function flat(lists) {
  const out = new Map();
  for (const list of lists ?? []) {
    for (const item of list.items ?? []) {
      out.set(item.itemId, {
        list: list.name,
        item: item.text,
        addedBy: item.addedBy ?? null,
      });
    }
  }
  return out;
}

/** The turn's changes between two readGroupLists() snapshots, keyed by item id. */
export function listChanges(before, after) {
  const was = flat(before);
  const now = flat(after);
  const added = [];
  const alreadyOn = [];
  const checkedOff = [];
  for (const [id, row] of now) (was.has(id) ? alreadyOn : added).push(row);
  for (const [id, row] of was) if (!now.has(id)) checkedOff.push(row);
  return { added, alreadyOn, checkedOff };
}

/** The judge's user payload for one group-lists case. */
export function groupListsJudgePayload({ fixture, reply, before, after }) {
  const senderFirst = fixture.sender.split(' ')[0];
  return {
    groupMessage: `${senderFirst}: ${fixture.text}`,
    reply,
    language: fixture.language,
    facts: {
      sender: { name: fixture.sender, shownAs: senderFirst },
      changes: listChanges(before, after),
      before,
      after,
      members: fixture.members,
    },
    secrets: fixture.secrets,
    watchFor: fixture.watchFor,
  };
}
