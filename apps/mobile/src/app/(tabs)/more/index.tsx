import { type Href, router } from 'expo-router';
import { Pressable, View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Icon, type IconName } from '@/components/ui/icon';
import { Screen } from '@/components/ui/screen';
import { useMeadowColor } from '@/constants/meadow';
import { useAuth } from '@/lib/auth';

type MenuItem = {
  label: string;
  detail: string;
  icon: IconName;
  href?: Href;
  action?: 'signOut';
};

const SECTIONS: { items: MenuItem[] }[] = [
  {
    items: [
      { label: 'Plan', detail: 'Your week ahead', icon: 'calendar', href: '/more/plan' },
      {
        label: 'Approvals',
        detail: 'Actions waiting for you',
        icon: 'checkmark.circle',
        href: '/more/approvals',
      },
      {
        label: 'Family',
        detail: 'Parents, children, area',
        icon: 'person.2',
        href: '/more/family',
      },
    ],
  },
  {
    items: [
      { label: 'Settings', detail: 'Notifications, privacy', icon: 'gearshape' },
      {
        label: 'Sign out',
        detail: '',
        icon: 'rectangle.portrait.and.arrow.right',
        action: 'signOut',
      },
    ],
  },
];

function MenuRow({ item, last, onPress }: { item: MenuItem; last: boolean; onPress: () => void }) {
  const icon = useMeadowColor('ink2');
  const chevron = useMeadowColor('ink3');
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={item.label}
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
      {item.href ? <Icon name="chevron.right" size={14} color={chevron} /> : null}
    </Pressable>
  );
}

export default function MoreScreen() {
  const { signOut } = useAuth();

  const activate = (item: MenuItem) => {
    if (item.action === 'signOut') {
      signOut();
      return;
    }
    if (item.href) router.push(item.href);
  };

  return (
    <Screen scroll className="gap-5">
      <AppText variant="display" className="pt-2">
        More
      </AppText>
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
              onPress={() => activate(item)}
            />
          ))}
        </View>
      ))}
    </Screen>
  );
}
