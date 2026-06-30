import { type Href, router } from 'expo-router';
import { Pressable, View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Icon, type IconName } from '@/components/ui/icon';
import { Screen } from '@/components/ui/screen';
import { useMeadowColor } from '@/constants/meadow';

type MenuItem = {
  label: string;
  detail: string;
  icon: IconName;
  href?: Href;
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
      { label: 'Sign out', detail: '', icon: 'rectangle.portrait.and.arrow.right' },
    ],
  },
];

function MenuRow({ item, last }: { item: MenuItem; last: boolean }) {
  const icon = useMeadowColor('ink2');
  const chevron = useMeadowColor('ink3');
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={item.label}
      onPress={() => item.href && router.push(item.href)}
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
            <MenuRow key={item.label} item={item} last={i === section.items.length - 1} />
          ))}
        </View>
      ))}
    </Screen>
  );
}
