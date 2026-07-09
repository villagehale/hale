import { type Href, router, useFocusEffect } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useCallback } from 'react';
import { Alert, Pressable, View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Icon, type IconName } from '@/components/ui/icon';
import { Screen } from '@/components/ui/screen';
import { useMeadowColor } from '@/constants/meadow';
import type { MobileApprovalsResponse, MobileFamilyResponse } from '@/lib/api-types';
import { useAuth } from '@/lib/auth';
import { useApi } from '@/lib/use-api';

type MenuItem = {
  label: string;
  detail: string;
  icon: IconName;
  href?: Href;
  action?: 'signOut';
  /** Opens outside the app (guides on villagehale.com) — real content, no dead rows. */
  externalUrl?: string;
};

const SECTIONS: { items: MenuItem[] }[] = [
  {
    items: [
      {
        label: 'Family',
        detail: 'Parents, children, area',
        icon: 'person.2',
        href: '/more/family',
      },
      { label: 'Plan', detail: 'Your week ahead', icon: 'calendar', href: '/more/plan' },
      {
        label: 'Saved',
        detail: "Activities you're interested in",
        icon: 'bookmark',
        href: '/more/saved',
      },
      {
        label: 'Activity',
        detail: 'Actions waiting for you',
        icon: 'checkmark.circle',
        href: '/more/approvals',
      },
      {
        label: 'Messages',
        detail: "Hale's notes to you",
        icon: 'envelope',
        href: '/more/messages',
      },
    ],
  },
  {
    items: [
      {
        label: 'Plan & billing',
        detail: 'Your plan and what it includes',
        icon: 'creditcard',
        href: '/more/plan-tiers',
      },
      {
        label: 'Resources',
        detail: 'Guides & answers from Hale',
        icon: 'book',
        externalUrl: 'https://www.villagehale.com/faq',
      },
      {
        label: 'Settings',
        detail: 'Notifications, privacy',
        icon: 'gearshape',
        href: '/more/settings',
      },
      {
        label: 'Sign out',
        detail: '',
        icon: 'rectangle.portrait.and.arrow.right',
        action: 'signOut',
      },
    ],
  },
];

/** A small orange count pill for the Approvals and Messages rows — surfaced only
 * when actions are actually waiting (both rows show the same pending count; the
 * drafted rows appear in the feed too). Orange stays scarce: this is one of the
 * few status marks that earns the accent. */
function CountBadge({ count }: { count: number }) {
  return (
    <View className="h-6 min-w-6 items-center justify-center rounded-full bg-accent px-2">
      {/* No own a11y label — the row's label carries "{n} waiting" so VoiceOver
          reads it (a label here is masked by the row's container label). */}
      <AppText variant="meta" className="text-[12px] leading-none text-on-ink">
        {count}
      </AppText>
    </View>
  );
}

/** The first letter of the viewer's name (or email), for the avatar circle — the
 * app has no uploaded avatars, so an initial stands in (mirrors web's account chip). */
function avatarInitial(name: string | null, email: string | null): string {
  const source = name?.trim() || email?.trim() || '';
  return source.charAt(0).toUpperCase() || '?';
}

/** The More profile header: an initial avatar + the SIGNED-IN parent's name/email.
 * The viewer comes from the family route's `viewer` (this session), never
 * members.primary — that slot is the OTHER parent in a co-parent household. Renders
 * quietly: if the family fetch hasn't landed, the header simply stays hidden. */
function ProfileHeader({ viewer }: { viewer: MobileFamilyResponse['viewer'] | undefined }) {
  const accentText = useMeadowColor('onAccent');
  if (!viewer) return null;
  const primary = viewer.name?.trim() || viewer.email?.trim() || 'You';
  return (
    <View className="flex-row items-center gap-3 rounded-lg border border-rule bg-card px-4 py-4">
      <View className="h-11 w-11 items-center justify-center rounded-full bg-accent">
        <AppText variant="title" style={{ color: accentText }}>
          {avatarInitial(viewer.name, viewer.email)}
        </AppText>
      </View>
      <View className="flex-1">
        <AppText variant="body" numberOfLines={1} className="text-ink">
          {primary}
        </AppText>
        {viewer.email ? (
          <AppText variant="meta" numberOfLines={1}>
            {viewer.email}
          </AppText>
        ) : null}
      </View>
    </View>
  );
}

function MenuRow({
  item,
  last,
  badge,
  onPress,
}: {
  item: MenuItem;
  last: boolean;
  badge?: number;
  onPress: () => void;
}) {
  const icon = useMeadowColor('ink2');
  const chevron = useMeadowColor('ink3');
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={badge && badge > 0 ? `${item.label}, ${badge} waiting` : item.label}
      onPress={onPress}
      className={`flex-row items-center gap-3 px-4 py-4 active:opacity-80 ${
        last ? '' : 'border-rule border-b'
      }`}
    >
      <Icon name={item.icon} size={20} color={icon} />
      <View className="flex-1">
        <AppText variant="body" className="text-ink">
          {item.label}
        </AppText>
        {item.detail ? <AppText variant="meta">{item.detail}</AppText> : null}
      </View>
      {badge && badge > 0 ? <CountBadge count={badge} /> : null}
      {item.href ? <Icon name="chevron.right" size={14} color={chevron} /> : null}
    </Pressable>
  );
}

export default function MoreScreen() {
  const { signOut } = useAuth();
  // A quiet count for the Approvals badge — no loading/error UI on this static
  // menu; if the fetch hasn't landed (or failed), the badge simply stays hidden.
  // expo-router keeps this tab mounted, so re-fetch on focus (refresh keeps the
  // shown count, no blink) — otherwise the badge is stale after approving in
  // /more/approvals and returning.
  const { data: approvals, refresh } = useApi<MobileApprovalsResponse>('/api/mobile/approvals');
  const pendingCount = approvals?.approvals.length ?? 0;
  // The signed-in parent's identity for the profile header — from the family route's
  // `viewer` (this session), not members.primary (the co-parent case reads wrong).
  const { data: family } = useApi<MobileFamilyResponse>('/api/mobile/family');
  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh]),
  );

  const activate = (item: MenuItem) => {
    if (item.action === 'signOut') {
      Alert.alert('Sign out?', 'You can sign back in anytime.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Sign out', style: 'destructive', onPress: signOut },
      ]);
      return;
    }
    if (item.externalUrl) {
      void WebBrowser.openBrowserAsync(item.externalUrl);
      return;
    }
    if (item.href) router.push(item.href);
  };

  return (
    <Screen scroll className="gap-5">
      <AppText variant="display" className="pt-2">
        More
      </AppText>
      <ProfileHeader viewer={family?.viewer} />
      {SECTIONS.map((section) => (
        <View
          key={section.items[0].label}
          className="overflow-hidden rounded-lg border border-rule bg-card"
        >
          {section.items.map((item, i) => (
            <MenuRow
              key={item.label}
              item={item}
              last={i === section.items.length - 1}
              badge={
                item.href === '/more/approvals' || item.href === '/more/messages'
                  ? pendingCount
                  : undefined
              }
              onPress={() => activate(item)}
            />
          ))}
        </View>
      ))}
    </Screen>
  );
}
