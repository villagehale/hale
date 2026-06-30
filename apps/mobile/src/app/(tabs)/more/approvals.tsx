import { useState } from 'react';
import { View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Screen } from '@/components/ui/screen';
import { ScreenHeader } from '@/components/ui/screen-header';
import { Tag } from '@/components/ui/tag';
import { APPROVAL_ACTIONS, type ApprovalAction } from '@/constants/approvals-data';

function PayloadBlock({ action }: { action: ApprovalAction }) {
  if (action.teenRedacted) {
    return (
      <View className="gap-1.5 rounded-md border border-rule bg-canvas p-3">
        <Tag label="Redacted · teen privacy" tone="attention" />
        <AppText variant="meta" className="mt-1">
          Category: {action.category}
        </AppText>
        <AppText variant="meta">
          Raw content is hidden by default. Maya can grant time-limited access if you ask.
        </AppText>
      </View>
    );
  }
  return (
    <View className="rounded-md border border-rule bg-canvas p-3">
      <AppText variant="mono" className="text-ink-3">
        {action.payload}
      </AppText>
    </View>
  );
}

function ActionCard({
  action,
  onResolve,
}: {
  action: ApprovalAction;
  onResolve: () => void;
}) {
  return (
    <Card className="gap-2">
      <View className="flex-row items-start justify-between gap-3">
        <Tag
          label={action.verdict === 'approve' ? 'Reviewer: approve' : 'Reviewer: needs review'}
          tone={action.verdict === 'approve' ? 'done' : 'coach'}
        />
        <AppText variant="mono" className="text-ink-3">
          {action.subject}
        </AppText>
      </View>

      <AppText variant="title" className="mt-1">
        {action.actionType}
      </AppText>
      <AppText variant="body">{action.preview}</AppText>

      <PayloadBlock action={action} />

      <AppText variant="meta">{action.reviewerNote}</AppText>

      <View className="mt-1 flex-row gap-2">
        <Button label="Approve" onPress={onResolve} className="flex-1" />
        <Button label="Dismiss" variant="secondary" onPress={onResolve} className="flex-1" />
      </View>
    </Card>
  );
}

export default function ApprovalsScreen() {
  const [queue, setQueue] = useState<ApprovalAction[]>(APPROVAL_ACTIONS);

  const resolve = (id: string) => setQueue((prev) => prev.filter((a) => a.id !== id));

  return (
    <Screen scroll className="gap-5">
      <ScreenHeader title="Approvals" back />

      {queue.length === 0 ? (
        <Card className="mt-2 items-center gap-2 py-10">
          <AppText variant="title">You're all caught up</AppText>
          <AppText variant="meta" className="text-center">
            No actions are waiting. Hale will queue anything that needs your okay here.
          </AppText>
        </Card>
      ) : (
        <View className="gap-3">
          <AppText variant="meta" className="-mt-2">
            {queue.length} action{queue.length === 1 ? '' : 's'} waiting for your okay. Nothing
            happens without it.
          </AppText>
          {queue.map((action) => (
            <ActionCard key={action.id} action={action} onResolve={() => resolve(action.id)} />
          ))}
        </View>
      )}

      <Card raised className="gap-2">
        <Tag label="Autonomy" tone="coach" />
        <AppText variant="title">Fewer taps once you trust it</AppText>
        <AppText variant="body">
          After you approve the same kind of action five times, you can let Hale handle it
          automatically — still logged, still reversible.
        </AppText>
      </Card>
    </Screen>
  );
}
