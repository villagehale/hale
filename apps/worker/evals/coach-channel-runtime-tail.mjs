/**
 * The runtime tail on a coach SMS, in the order `toSmsReply` appends it.
 *
 * An activity URL is last. The nearby-count clause sits just before that URL, or
 * at the end when no page was appended. A plan offer or a referral block is the
 * protected suffix in front of the URL, and the count is not appended on that
 * turn. Sentence budget and the judge's provenance both have to see this tail as
 * Hale's, not as sentences the model wrote.
 */

function endsWith(hay, needle, ignoreCase) {
  if (!needle) return false;
  if (!ignoreCase) return hay.endsWith(needle);
  return hay.toLowerCase().endsWith(needle.toLowerCase());
}

function cutSuffix(hay, needle) {
  return hay.slice(0, hay.length - needle.length).trim();
}

export function stripTrailingActivityUrls(text, links, ignoreCase = false) {
  const urls = [
    ...new Set((links ?? []).map((link) => link?.url).filter((url) => typeof url === 'string' && url !== '')),
  ].sort((a, b) => b.length - a.length);
  let out = String(text).trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const url of urls) {
      if (!endsWith(out, url, ignoreCase)) continue;
      out = cutSuffix(out, url);
      changed = true;
      break;
    }
  }
  return out;
}

/**
 * Model prose only. Strips a trailing activity URL, then a trailing nearby
 * clause, then the plan-offer / referral block — the same join `toSmsReply` uses.
 */
export function modelProse(text, { appended = '', nearbyClause = '', links = [], ignoreCase = false } = {}) {
  let out = stripTrailingActivityUrls(text, links, ignoreCase);
  if (nearbyClause && endsWith(out, nearbyClause, ignoreCase)) out = cutSuffix(out, nearbyClause);
  if (appended && endsWith(out, appended, ignoreCase)) out = cutSuffix(out, appended);
  return out;
}

/** The count Hale appended: the clause alone, or the clause with the page URL after it. */
export function nearbyCountWasAppended(reply, clause, links) {
  if (!clause || reply == null || reply === '') return false;
  if (reply.endsWith(clause)) return true;
  return stripTrailingActivityUrls(reply, links).endsWith(clause);
}
