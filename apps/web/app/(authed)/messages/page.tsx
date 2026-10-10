import type { Metadata } from 'next';
import { PortalMessagesPage } from '~/components/portal/messages-page';

export const metadata: Metadata = { title: 'Messages' };

/** Messages — what was said, what Hale did, and what's waiting. */
export default function MessagesPage() {
  return PortalMessagesPage();
}
