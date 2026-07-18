import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { Pressable, View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { DetailHeader } from '@/components/ui/detail-header';
import { Icon } from '@/components/ui/icon';
import { useTintedRefresh } from '@/components/ui/pull-refresh';
import { Screen } from '@/components/ui/screen';
import { ErrorState, LoadingState } from '@/components/ui/screen-state';
import { type ChipTone, TintChip } from '@/components/ui/tint-chip';
import type { IconName } from '@/components/ui/icon';
import { useMeadowColor } from '@/constants/meadow';
import type {
  ApprovalView,
  MessageView,
  MobileApprovalsResponse,
  MobileMessagesResponse,
} from '@/lib/api-types';
import { humanizeActionType } from '@/lib/approval-format';
import { markAllNotifsRead, useNotifsAcknowledged } from '@/lib/notif-dot';
import { useApi } from '@/lib/use-api';

/**
 * Notifications (handoff) — reached from the Home bell. Three honest groups over
 * REAL data (no invented rows): NEEDS YOUR APPROVAL (pending approvals, each an
 * orange-dotted row into its decision page), then the family's notes split by the
 * server's family-zone `today` flag into TODAY and EARLIER. "Mark all read"
 * acknowledges the message stream for the session (see notif-dot); the bell dot
 * still honors genuine pending approvals.
 *
 * Rule #1: approvals and messages arrive already teen-redacted from the server — a
 * 13+ teen's raw content never reaches here (approval preview degrades to the
 * placeholder; a teen action note carries only "Private"). This screen renders what
 * the server sends and never un-redacts. Both reads refetch on focus so acting in a
 * pushed route reflects the moment you return.
 */

/** The shared row skeleton: a tinted icon chip, a title over a one-line subtitle,
 * and an optional trailing mark (the approval dot, a timestamp, a chevron). */
function NotifRow({
  icon,
  tone,
  title,
  subtitle,
  trailing,
  onPress,
  last,
  accessibilityLabel,
}: {
  icon: IconName;
  tone: ChipTone;
  title: string;
  subtitle: string;
  trailing?: ReactNode;
  onPress?: () => void;
  last: boolean;
  accessibilityLabel: string;
}) {
  const body = (
    <>
      <TintChip icon={icon} tone={tone} />
      <View className="flex-1">
        <AppText
          numberOfLines={1}
          className="text-[14px] text-ink"
          style={{ fontFamily: 'InstrumentSans_600SemiBold' }}
        >
          {title}
        </AppText>
        <AppText variant="meta" numberOfLines={1} className="text-caption">
          {subtitle}
        </AppText>
      </View>
      {trailing}
    </>
  );
  const rowClass = `flex-row items-center gap-3 px-4 py-3.5 ${last ? '' : 'border-hairline border-b'}`;

  if (onPress) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        onPress={onPress}
        className={`${rowClass} active:opacity-80`}
      >
        {body}
      </Pressable>
    );
  }
  return (
    <View accessibilityLabel={accessibilityLabel} className={rowClass}>
      {body}
    </View>
  );
}

/** The scarce earned-orange dot marking an approval still awaiting a decision. */
function ApprovalDot() {
  return <View className="h-2 w-2 rounded-full bg-accent" />;
}

function ApprovalNotifRow({ action, last }: { action: ApprovalView; last: boolean }) {
  return (
    <NotifRow
      icon="circle-check"
      tone="blue"
      title={humanizeActionType(action.actionType)}
      subtitle={action.preview}
      trailing={<ApprovalDot />}
      onPress={() => router.push(`/approval/${action.id}`)}
      last={last}
      accessibilityLabel={`${humanizeActionType(action.actionType)}. Needs your approval. Opens the decision.`}
    />
  );
}

/** Icon + tone for a message note, derived from what the row actually is — a teen
 * note reads "Private" (rule #1), a digest is Hale's brief, an action reflects its
 * lifecycle. Never color alone: the eyebrow/body carries the meaning too. */
function messageChip(message: MessageView): { icon: IconName; tone: ChipTone } {
  if (message.teenRedacted) return { icon: 'shield', tone: 'red' };
  if (message.kind === 'digest') return { icon: 'sparkles', tone: 'blue' };
  switch (message.actionState) {
    case 'autonomous':
      return { icon: 'circle-check', tone: 'green' };
    case 'needs_human':
      return { icon: 'bell', tone: 'yellow' };
    case 'reverted':
      return { icon: 'circle-x', tone: 'gray' };
    default:
      return { icon: 'clock', tone: 'yellow' };
  }
}

function MessageNotifRow({ message, last }: { message: MessageView; last: boolean }) {
  const chevron = useMeadowColor('ink3');
  const { icon, tone } = messageChip(message);
  // Only a drafted action leads somewhere — the parent's yes lives on Approvals
  // (mirrors the Messages page). The rest are read-only notes.
  const navigates = message.actionState === 'drafted_for_approval';
  return (
    <NotifRow
      icon={icon}
      tone={tone}
      title={message.eyebrow}
      subtitle={message.body}
      trailing={
        <View className="flex-row items-center gap-1.5">
          <AppText variant="mono" className="shrink-0 text-ink-3">
            {message.when}
          </AppText>
          {navigates ? <Icon name="chevron-right" size={14} color={chevron} /> : null}
        </View>
      }
      onPress={navigates ? () => router.push('/approvals') : undefined}
      last={last}
      accessibilityLabel={
        navigates ? `${message.eyebrow}. ${message.body} Opens Approvals.` : `${message.eyebrow}. ${message.body}`
      }
    />
  );
}

/** A titled group with its bordered, row-divided card. The first rendered group also
 * carries "Mark all read" (prototype places it on the section-label row). */
function Section({
  label,
  action,
  children,
}: {
  label: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <View className="gap-2.5">
      <View className="flex-row items-center justify-between">
        <AppText variant="eyebrow">{label}</AppText>
        {action}
      </View>
      <View className="overflow-hidden rounded-[20px] border border-rule bg-card">{children}</View>
    </View>
  );
}

function MarkAllRead() {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Mark all read"
      onPress={markAllNotifsRead}
      className="active:opacity-60"
    >
      <AppText
        className="text-[13px] text-accent"
        style={{ fontFamily: 'InstrumentSans_600SemiBold' }}
      >
        Mark all read
      </AppText>
    </Pressable>
  );
}

function NotificationsBody({
  approvals,
  messages,
}: {
  approvals: ApprovalView[];
  messages: MessageView[];
}) {
  const acknowledged = useNotifsAcknowledged();
  const today = messages.filter((m) => m.today);
  const earlier = messages.filter((m) => !m.today);

  if (approvals.length === 0 && messages.length === 0) {
    return (
      <Card className="mt-2 items-center gap-2 py-10">
        <AppText variant="title">You&rsquo;re all caught up</AppText>
        <AppText variant="meta" className="text-center">
          Approvals, reminders, and updates from Hale will show up here.
        </AppText>
      </Card>
    );
  }

  // "Mark all read" rides the FIRST rendered group; it drops once acknowledged.
  const groups: { key: string; label: string; rows: ReactNode }[] = [];
  if (approvals.length > 0) {
    groups.push({
      key: 'approvals',
      label: 'Needs your approval',
      rows: approvals.map((a, i) => (
        <ApprovalNotifRow key={a.id} action={a} last={i === approvals.length - 1} />
      )),
    });
  }
  if (today.length > 0) {
    groups.push({
      key: 'today',
      label: 'Today',
      rows: today.map((m, i) => (
        <MessageNotifRow key={m.id} message={m} last={i === today.length - 1} />
      )),
    });
  }
  if (earlier.length > 0) {
    groups.push({
      key: 'earlier',
      label: 'Earlier',
      rows: earlier.map((m, i) => (
        <MessageNotifRow key={m.id} message={m} last={i === earlier.length - 1} />
      )),
    });
  }

  return (
    <>
      {groups.map((g, i) => (
        <Section key={g.key} label={g.label} action={i === 0 && !acknowledged ? <MarkAllRead /> : undefined}>
          {g.rows}
        </Section>
      ))}
    </>
  );
}

export default function NotificationsScreen() {
  const approvals = useApi<MobileApprovalsResponse>('/api/mobile/approvals', {
    refetchOnFocus: true,
  });
  const messages = useApi<MobileMessagesResponse>('/api/mobile/messages', {
    refetchOnFocus: true,
  });

  const loading = approvals.status === 'loading' || messages.status === 'loading';
  const errorMessage = approvals.error ?? messages.error;
  const ready = approvals.status === 'ready' && messages.status === 'ready';
  const refresh = () => Promise.all([approvals.refresh(), messages.refresh()]);
  const reload = () => Promise.all([approvals.reload(), messages.reload()]);

  return (
    <Screen
      scroll
      className="gap-5"
      refreshControl={useTintedRefresh(approvals.refreshing || messages.refreshing, refresh)}
    >
      <DetailHeader title="Notifications" />
      {loading ? <LoadingState /> : null}
      {!loading && errorMessage ? <ErrorState message={errorMessage} onRetry={reload} /> : null}
      {ready && approvals.data && messages.data ? (
        <NotificationsBody approvals={approvals.data.approvals} messages={messages.data.messages} />
      ) : null}
    </Screen>
  );
}
