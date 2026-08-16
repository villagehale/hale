import type { TrailView } from '~/lib/dashboard/mappers';

/**
 * The trail's grouping rule: several audit rows about ONE action are one thing that
 * happened, not four. A draft that was minted, reviewed, approved and carried out
 * writes four rows, and a parent scrolling their record should read "Hale added swim
 * to the calendar" once, with the four steps underneath if they want them.
 *
 * Pure, and deliberately grouping WITHIN the day the caller hands it: the timeline is
 * sectioned by day, and an action whose lifecycle straddles midnight genuinely is two
 * things on the record — "drafted last night", "you approved it this morning". Merging
 * across days would put a step under a heading it did not happen on.
 *
 * Rows that resolve to no action, and actions with a single row, stay single: a
 * disclosure that reveals one line identical to its own summary is not a disclosure.
 */

export interface TrailTrace {
  kind: 'trace';
  /** The action id — also the group's DOM anchor, so `/trail#<action-id>` lands. */
  actionId: string;
  /** Newest first, as the query ordered them: `rows[0]` is where the action got to. */
  rows: TrailView[];
}

export interface TrailSingle {
  kind: 'single';
  row: TrailView;
}

export type TrailItem = TrailTrace | TrailSingle;

/** A stable React key for either shape. Audit ids and action ids are both uuids from
 * different tables, so the kind prefix keeps them from ever colliding. */
export function trailItemKey(item: TrailItem): string {
  return item.kind === 'trace' ? `trace-${item.actionId}` : `row-${item.row.id}`;
}

/**
 * Groups a day's rows into lifecycles, preserving the incoming order: a trace takes
 * the position of its FIRST row, so the day still reads newest-first by the most
 * recent thing that happened to each action.
 */
export function groupIntoTraces(rows: readonly TrailView[]): TrailItem[] {
  const byAction = new Map<string, TrailView[]>();
  for (const row of rows) {
    if (row.actionId === null) continue;
    const group = byAction.get(row.actionId);
    if (group) group.push(row);
    else byAction.set(row.actionId, [row]);
  }

  const items: TrailItem[] = [];
  const emitted = new Set<string>();
  for (const row of rows) {
    const actionId = row.actionId;
    const group = actionId === null ? undefined : byAction.get(actionId);
    if (actionId === null || !group || group.length < 2) {
      items.push({ kind: 'single', row });
      continue;
    }
    if (emitted.has(actionId)) continue;
    emitted.add(actionId);
    items.push({ kind: 'trace', actionId, rows: group });
  }
  return items;
}
