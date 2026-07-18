import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { DetailHeader } from '@/components/ui/detail-header';
import { Screen } from '@/components/ui/screen';

/**
 * Placeholder Notifications page reached from the Home bell. Task 12 fills it in (the
 * approvals / today / earlier groups and a real "Mark all read" that calls
 * markAllNotifsRead in lib/notif-dot). For now it's an honest empty state so the bell
 * navigates somewhere real.
 */
export default function NotificationsScreen() {
  return (
    <Screen scroll className="gap-5">
      <DetailHeader title="Notifications" />
      <Card className="mt-2 items-center gap-2 py-10">
        <AppText variant="title">You&rsquo;re all caught up</AppText>
        <AppText variant="meta" className="text-center">
          Approvals, reminders, and updates from Hale will show up here.
        </AppText>
      </Card>
    </Screen>
  );
}
