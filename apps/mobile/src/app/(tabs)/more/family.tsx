import { View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { useTintedRefresh } from '@/components/ui/pull-refresh';
import { Screen } from '@/components/ui/screen';
import { ScreenHeader } from '@/components/ui/screen-header';
import { ErrorState, LoadingState } from '@/components/ui/screen-state';
import { Tag } from '@/components/ui/tag';
import type { FamilyLocationView, MemberView, MobileFamilyResponse } from '@/lib/api-types';
import { useApi } from '@/lib/use-api';

const ROLE_LABEL: Record<string, string> = {
  primary_parent: 'You',
  co_parent: 'Co-parent',
};

// Mirrored from @hale/types ONBOARDING_INTENTS — the intents come back as their
// stored values; show the same labels the web wizard/settings use.
const INTENT_LABEL: Record<string, string> = {
  activities: 'Activities & classes',
  childcare: 'Childcare',
  milestones: 'Milestones & development',
  planning: 'Weekly planning & routine',
  sitter: 'Trusted sitter/nanny',
  health: 'Health & specialists',
  community: 'Meeting other families',
  exploring: 'Just exploring',
};

function SectionTitle({ children }: { children: string }) {
  return (
    <AppText variant="meta" className="uppercase tracking-eyebrow text-ink-3">
      {children}
    </AppText>
  );
}

function coarseArea(location: FamilyLocationView): string {
  const parts = [location.city, location.province, location.postalCode].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : 'Not set';
}

function ParentRow({ member }: { member: MemberView }) {
  return (
    <View className="flex-row items-center justify-between">
      <View className="flex-1">
        <AppText variant="body" className="text-ink">
          {member.name ?? member.email}
        </AppText>
        <AppText variant="meta">{member.email}</AppText>
      </View>
      <Tag label={ROLE_LABEL[member.role] ?? member.role} tone="neutral" />
    </View>
  );
}

function FamilyBody({ data }: { data: MobileFamilyResponse }) {
  const { members, basics } = data;
  return (
    <>
      <View className="gap-2">
        <SectionTitle>Parents</SectionTitle>
        <Card className="gap-3">
          {members.primary ? <ParentRow member={members.primary} /> : null}
          {members.coParent ? (
            <ParentRow member={members.coParent} />
          ) : (
            <View className="border-t border-rule pt-3">
              <AppText variant="meta">
                Co-parent invite pending — a second parent can join to share this household.
              </AppText>
            </View>
          )}
        </Card>
      </View>

      <View className="gap-2">
        <SectionTitle>Children</SectionTitle>
        {basics.children.length === 0 ? (
          <Card>
            <AppText variant="meta">No children added yet.</AppText>
          </Card>
        ) : (
          basics.children.map((child) => (
            <Card key={child.id} className="flex-row items-center justify-between">
              <View>
                <AppText variant="body" className="text-ink">
                  {child.name}
                </AppText>
                <AppText variant="meta">{child.dateOfBirth}</AppText>
              </View>
              <Tag label={child.stageLabel} tone="coach" />
            </Card>
          ))
        )}
      </View>

      <View className="gap-2">
        <SectionTitle>Your area</SectionTitle>
        <Card className="gap-1">
          <AppText variant="body" className="text-ink">
            {coarseArea(basics.location)}
          </AppText>
          <AppText variant="meta">
            Drives local discovery using a coarse area only — never your exact address.
          </AppText>
        </Card>
      </View>

      {basics.intents.length > 0 ? (
        <View className="gap-2">
          <SectionTitle>What you're hoping for</SectionTitle>
          <Card>
            <View className="flex-row flex-wrap gap-2">
              {basics.intents.map((intent) => (
                <Tag key={intent} label={INTENT_LABEL[intent] ?? intent} tone="coach" />
              ))}
            </View>
          </Card>
        </View>
      ) : null}
    </>
  );
}

export default function FamilyScreen() {
  const { status, data, error, refreshing, reload, refresh } =
    useApi<MobileFamilyResponse>('/api/mobile/family');

  return (
    <Screen scroll className="gap-6" refreshControl={useTintedRefresh(refreshing, refresh)}>
      <ScreenHeader title="Family" back />
      {status === 'loading' ? <LoadingState /> : null}
      {status === 'error' ? <ErrorState message={error ?? ''} onRetry={reload} /> : null}
      {status === 'ready' && data ? <FamilyBody data={data} /> : null}
    </Screen>
  );
}
