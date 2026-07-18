import { router } from 'expo-router';
import { useState } from 'react';
import { Modal, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useMeadowColor } from '@/constants/meadow';

import { AppText } from './app-text';
import { Icon, type IconName } from './icon';
import { IconButton } from './icon-button';

/**
 * The shared detail-page header (handoff): a circular back button, a 16/700 title,
 * and a ⋯ overflow that opens a 176px dropdown (Share / Save / Get help). The menu
 * is a transparent Modal so a tap anywhere outside dismisses it; it's pinned to the
 * top-right below the ⋯ button using the safe-area inset. Callers can override the
 * menu items; defaults match the prototype.
 */
export type OverflowAction = { label: string; icon: IconName; onPress?: () => void };

const DEFAULT_MENU: OverflowAction[] = [
  { label: 'Share', icon: 'share' },
  { label: 'Save', icon: 'bookmark' },
  { label: 'Get help', icon: 'circle-help' },
];

const MENU_SHADOW = {
  shadowOpacity: 0.14,
  shadowRadius: 20,
  shadowOffset: { width: 0, height: 12 },
  elevation: 12,
} as const;

export function DetailHeader({
  title,
  menu = DEFAULT_MENU,
}: {
  title: string;
  menu?: OverflowAction[];
}) {
  const [open, setOpen] = useState(false);
  const insets = useSafeAreaInsets();
  const rowIcon = useMeadowColor('ink3');
  const shadowColor = useMeadowColor('ink');

  return (
    <View className="flex-row items-center gap-3 pt-2">
      <IconButton
        icon="chevron-left"
        accessibilityLabel="Go back"
        size={18}
        onPress={() => router.back()}
      />
      <AppText
        numberOfLines={1}
        className="flex-1 text-[16px] leading-[22px] text-ink"
        style={{ fontFamily: 'InstrumentSans_700Bold' }}
      >
        {title}
      </AppText>
      <IconButton
        icon="ellipsis"
        accessibilityLabel="More options"
        size={20}
        onPress={() => setOpen(true)}
      />

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable className="flex-1" accessibilityLabel="Close menu" onPress={() => setOpen(false)}>
          <View
            className="absolute w-44 overflow-hidden rounded-[14px] border border-rule bg-card"
            style={{ top: insets.top + 52, right: 20, shadowColor, ...MENU_SHADOW }}
          >
            {menu.map((item, i) => (
              <Pressable
                key={item.label}
                accessibilityRole="button"
                accessibilityLabel={item.label}
                onPress={() => {
                  setOpen(false);
                  item.onPress?.();
                }}
                className={`flex-row items-center gap-2.5 px-3.5 py-3 active:opacity-70 ${
                  i === menu.length - 1 ? '' : 'border-b border-hairline'
                }`}
              >
                <Icon name={item.icon} size={14} color={rowIcon} />
                <AppText
                  className="text-[13.5px] text-ink"
                  style={{ fontFamily: 'InstrumentSans_600SemiBold' }}
                >
                  {item.label}
                </AppText>
              </Pressable>
            ))}
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}
