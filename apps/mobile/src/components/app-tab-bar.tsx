import type { BottomTabBarProps } from 'expo-router/js-tabs';
import { SymbolView, type SymbolViewProps } from 'expo-symbols';
import { Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppText } from '@/components/ui/app-text';
import { useMeadowColor } from '@/constants/meadow';

type TabMeta = { label: string; icon: SymbolViewProps['name']; center?: boolean };

const TABS: Record<string, TabMeta> = {
  index: { label: 'Home', icon: 'house.fill' },
  companion: { label: 'Companion', icon: 'figure.2.and.child.holdinghands' },
  ask: { label: 'Ask', icon: 'sparkles', center: true },
  village: { label: 'Village', icon: 'map.fill' },
  more: { label: 'More', icon: 'ellipsis' },
};

export function AppTabBar({ state, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  const activeTint = useMeadowColor('ink');
  const inactiveTint = useMeadowColor('ink3');
  const centerTint = useMeadowColor('canvas');

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

        if (meta.center) {
          return (
            <Pressable
              key={route.key}
              accessibilityRole="button"
              accessibilityLabel={meta.label}
              accessibilityState={isFocused ? { selected: true } : {}}
              onPress={onPress}
              className="flex-1 items-center justify-end"
            >
              <View className="-mt-6 h-14 w-14 items-center justify-center rounded-full bg-accent-fill active:opacity-90">
                <SymbolView name={meta.icon} size={24} tintColor={centerTint} />
              </View>
              <AppText variant="meta" className="mt-1 text-[11px] text-ink-2">
                {meta.label}
              </AppText>
            </Pressable>
          );
        }

        return (
          <Pressable
            key={route.key}
            accessibilityRole="button"
            accessibilityLabel={meta.label}
            accessibilityState={isFocused ? { selected: true } : {}}
            onPress={onPress}
            className="flex-1 items-center justify-end gap-1 pb-1 active:opacity-80"
          >
            <SymbolView
              name={meta.icon}
              size={22}
              tintColor={isFocused ? activeTint : inactiveTint}
            />
            <AppText
              variant="meta"
              className={`text-[11px] ${isFocused ? 'text-ink' : 'text-ink-3'}`}
            >
              {meta.label}
            </AppText>
          </Pressable>
        );
      })}
    </View>
  );
}
