import type { Metadata } from 'next';
import { PortalHeading } from '~/components/portal/heading';
import { MessagesBoard } from '~/components/portal/messages-board';

export const metadata: Metadata = { title: 'Messages' };

export default function DemoMessagesPage() {
  return (
    <>
      <PortalHeading
        title="Messages"
        lede="Everything you and Hale have said, and everything Hale did."
      />
      <MessagesBoard items={[]} approvals={[]} />
    </>
  );
}
