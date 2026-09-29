/**
 * Where the signup result may go.
 *
 * A claimed Linq co-parent group is the door. Otherwise the thread the parent
 * already opened. Hale does not start a 1:1 just to report this.
 */
export type ReportDoor =
  | { kind: 'group'; chatId: string }
  | { kind: 'existing_thread' }
  | { kind: 'held'; reason: 'would_initiate_1_1' };

export function chooseReportDoor(input: {
  groupChatId: string | null;
  existingThread: boolean;
}): ReportDoor {
  const group = input.groupChatId?.trim() || null;
  if (group) return { kind: 'group', chatId: group };
  if (input.existingThread) return { kind: 'existing_thread' };
  return { kind: 'held', reason: 'would_initiate_1_1' };
}
