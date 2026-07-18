import Constants from 'expo-constants';
import { type Href, router, useFocusEffect } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useCallback } from 'react';
import { Alert, Pressable, View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Icon, type IconName } from '@/components/ui/icon';
import { Screen } from '@/components/ui/screen';
import { useMeadowColor } from '@/constants/meadow';
import type {
  MobileApprovalsResponse,
  MobileFamilyResponse,
  MobileMessagesResponse,
} from '@/lib/api-types';
import { useAuth } from '@/lib/auth';
import { useApi } from '@/lib/use-api';

/** Which real count feeds a row's badge — kept to the two surfaces that carry an
 * honest number (the pending-approvals count, the message count). */
type BadgeKey = 'approvals' | 'messages';

type MenuItem = {
  label: string;
  detail: string;
  icon: IconName;
  href?: Href;
  action?: 'signOut';
  /** Sign out — the one destructive row (red icon + label). */
  destructive?: boolean;
  badge?: BadgeKey;
  /** Opens outside the app (guides on villagehale.com) — real content, no dead rows. */
  externalUrl?: string;
};

const SECTIONS: { header: string; items: MenuItem[] }[] = [
  {
    header: 'Inbox',
    items: [
      {
        label: 'Approvals',
        detail: 'Actions waiting for you',
        icon: 'circle-check',
        href: '/approvals',
        badge: 'approvals',
      },
      {
        label: 'Messages',
        detail: 'Updates from your village',
        icon: 'mail',
        href: '/messages',
        badge: 'messages',
      },
    ],
  },
  {
    header: 'Library',
    items: [
      {
        label: 'Saved',
        detail: 'Your saved items',
        icon: 'bookmark',
        href: '/saved',
      },
      { label: 'Plan', detail: 'Your week ahead', icon: 'calendar', href: '/plan' },
      {
        label: 'Resources',
        detail: 'Guides and articles',
        icon: 'book-open',
        externalUrl: 'https://www.villagehale.com/faq',
      },
    ],
  },
  {
    header: 'Account',
    items: [
      {
        label: 'Plan & billing',
        detail: 'Your plan and what it includes',
        icon: 'credit-card',
        href: '/plan-tiers',
      },
      {
        label: 'Settings',
        detail: 'Notifications, privacy',
        icon: 'settings',
        href: '/settings',
      },
      {
        label: 'Sign out',
        detail: '',
        icon: 'log-out',
        action: 'signOut',
        destructive: true,
      },
    ],
  },
];

/** A small orange count pill for the Approvals and Messages rows — surfaced only when
 * a real count is waiting. Orange stays scarce: this is one of the few status marks
 * that earns the accent. */
function CountBadge({ count }: { count: number }) {
  return (
    <View className="h-6 min-w-6 items-center justify-center rounded-full bg-accent px-2">
      {/* No own a11y label — the row's label carries the count so VoiceOver reads it
          (a label here is masked by the row's container label). */}
      <AppText variant="meta" className="text-[12px] leading-none text-on-ink">
        {count}
      </AppText>
    </View>
  );
}

/** The first letter of the viewer's name (or email), for the avatar circle — the app
 * has no uploaded avatars, so an initial stands in (mirrors web's account chip). */
function avatarInitial(name: string | null, email: string | null): string {
  const source = name?.trim() || email?.trim() || '';
  return source.charAt(0).toUpperCase() || '?';
}

/** The More profile card: an initial avatar + the SIGNED-IN parent's name over a
 * "Profile & family" subtitle, tapping through to Family. The viewer comes from the
 * family route's `viewer` (this session), never members.primary — that slot is the
 * OTHER parent in a co-parent household. Renders quietly: if the family fetch hasn't
 * landed, the card simply stays hidden. */
function ProfileCard({ viewer }: { viewer: MobileFamilyResponse['viewer'] | undefined }) {
  const accentText = useMeadowColor('onAccent');
  const chevron = useMeadowColor('ink3');
  if (!viewer) return null;
  const primary = viewer.name?.trim() || viewer.email?.trim() || 'You';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${primary}. Profile and family`}
      onPress={() => router.push('/family')}
      className="flex-row items-center gap-3 rounded-[20px] border border-rule bg-card px-4 py-3.5 active:opacity-80"
    >
      <View className="h-11 w-11 items-center justify-center rounded-full bg-accent">
        <AppText variant="title" style={{ color: accentText }}>
          {avatarInitial(viewer.name, viewer.email)}
        </AppText>
      </View>
      <View className="flex-1">
        <AppText
          numberOfLines={1}
          className="text-[15px] text-ink"
          style={{ fontFamily: 'InstrumentSans_700Bold' }}
        >
          {primary}
        </AppText>
        <AppText variant="meta" className="text-caption">
          Profile &amp; family
        </AppText>
      </View>
      <Icon name="chevron-right" size={15} color={chevron} />
    </Pressable>
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
  const icon = useMeadowColor(item.destructive ? 'chipRedIcon' : 'ink2');
  const chevron = useMeadowColor('ink3');
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={badge && badge > 0 ? `${item.label}, ${badge} waiting` : item.label}
      onPress={onPress}
      className={`flex-row items-center gap-3 px-4 py-4 active:opacity-80 ${
        last ? '' : 'border-hairline border-b'
      }`}
    >
      <Icon name={item.icon} size={20} color={icon} />
      <View className="flex-1">
        <AppText className={`text-[14px] ${item.destructive ? 'text-destructive' : 'text-ink'}`}>
          {item.label}
        </AppText>
        {item.detail ? <AppText variant="meta" className="text-caption">{item.detail}</AppText> : null}
      </View>
      {badge && badge > 0 ? <CountBadge count={badge} /> : null}
      {item.href ? <Icon name="chevron-right" size={14} color={chevron} /> : null}
    </Pressable>
  );
}

export default function MoreScreen() {
  const { signOut } = useAuth();
  // Quiet counts for the badges — no loading/error UI on this static menu; if a fetch
  // hasn't landed (or failed), the badge simply stays hidden. expo-router keeps this
  // tab mounted, so re-fetch on focus (refresh keeps the shown count, no blink) —
  // otherwise the Approvals badge is stale after approving and returning.
  const { data: approvals, refresh } = useApi<MobileApprovalsResponse>('/api/mobile/approvals');
  const { data: messages } = useApi<MobileMessagesResponse>('/api/mobile/messages');
  const badgeFor: Record<BadgeKey, number> = {
    approvals: approvals?.approvals.length ?? 0,
    messages: messages?.messages.length ?? 0,
  };
  // The signed-in parent's identity for the profile card — from the family route's
  // `viewer` (this session), not members.primary (the co-parent case reads wrong).
  const { data: family } = useApi<MobileFamilyResponse>('/api/mobile/family');
  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh]),
  );

  const version = Constants.expoConfig?.version ?? '—';

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
      <ProfileCard viewer={family?.viewer} />
      {SECTIONS.map((section) => (
        <View key={section.header} className="gap-2.5">
          <AppText variant="eyebrow">{section.header}</AppText>
          <View className="overflow-hidden rounded-[20px] border border-rule bg-card">
            {section.items.map((item, i) => (
              <MenuRow
                key={item.label}
                item={item}
                last={i === section.items.length - 1}
                badge={item.badge ? badgeFor[item.badge] : undefined}
                onPress={() => activate(item)}
              />
            ))}
          </View>
        </View>
      ))}
      <AppText variant="meta" className="text-center text-caption">
        Version {version}
      </AppText>
    </Screen>
  );
}
