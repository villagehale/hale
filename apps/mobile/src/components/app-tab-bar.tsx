import type { BottomTabBarProps } from 'expo-router/js-tabs';
import { Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppText } from '@/components/ui/app-text';
import { Icon, type IconName } from '@/components/ui/icon';
import { useMeadowColor } from '@/constants/meadow';

type TabMeta = { label: string; icon: IconName; activeIcon: IconName };

const TABS: Record<string, TabMeta> = {
  index: { label: 'Home', icon: 'house', activeIcon: 'house' },
  companion: {
    label: 'Companion',
    icon: 'user',
    activeIcon: 'user',
  },
  ask: { label: 'Ask', icon: 'sparkles', activeIcon: 'sparkles' },
  village: { label: 'Village', icon: 'houses', activeIcon: 'houses' },
  more: { label: 'More', icon: 'ellipsis-filled', activeIcon: 'ellipsis-filled' },
};

export function AppTabBar({ state, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  const activeTint = useMeadowColor('brand');
  const inactiveTint = useMeadowColor('ink3');

  return (
    <View
      className="flex-row items-end border-t border-rule bg-card px-2 pt-2"
      style={{ paddingBottom: insets.bottom + 8 }}
    >
      {state.routes.map((route, index) => {
        const meta = TABS[route.name];
        if (!meta) return null;
        const isFocused = state.index === index;

        const onPress = () => {
          const event = navigation.emit({
            type: 'tabPress',
            target: route.key,
            canPreventDefault: true,
          });
          if (!isFocused && !event.defaultPrevented) {
            navigation.navigate(route.name);
          }
        };

        return (
          <Pressable
            key={route.key}
            accessibilityRole="button"
            accessibilityLabel={meta.label}
            accessibilityState={isFocused ? { selected: true } : {}}
            onPress={onPress}
            className="flex-1 items-center justify-end gap-1 pb-1 active:opacity-80"
          >
            <View>
              <Icon
                name={isFocused ? meta.activeIcon : meta.icon}
                size={22}
                color={isFocused ? activeTint : inactiveTint}
              />
            </View>
            <AppText
              variant="meta"
              className={`text-[11px] ${isFocused ? 'text-brand' : 'text-ink-3'}`}
            >
              {meta.label}
            </AppText>
          </Pressable>
        );
      })}
    </View>
  );
}
