import { loadFamilyTimezone, loadPendingApprovals, loadTrail } from '~/lib/dashboard/queries';
import { loadMessages } from '~/lib/messages/queries';
import { PortalHeading } from './heading';
import { MessagesBoard } from './messages-board';
import { buildThreadItems, zoneDayKeys } from './thread';

export async function PortalMessagesPage() {
  const [messages, trail, approvals, timeZone] = await Promise.all([
    loadMessages(),
    loadTrail(),
    loadPendingApprovals(),
    loadFamilyTimezone(),
  ]);
  const { today, yesterday } = zoneDayKeys(timeZone);
  return (
    <>
      <PortalHeading
        title="Messages"
        lede="Everything you and Hale have said, and everything Hale did."
      />
      <MessagesBoard
        items={buildThreadItems(trail, messages, today, yesterday)}
        approvals={approvals}
      />
    </>
  );
}
