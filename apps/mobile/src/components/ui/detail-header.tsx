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

// The default menu carries only the page-agnostic action — "Get help" opens the Ask
// surface. Share/Save need per-page content and a per-entity save target, so a page
// that supports them passes its own `menu`; a page that doesn't never ships them as
// dead rows (brief — honest beats literal).
const DEFAULT_MENU: OverflowAction[] = [
  { label: 'Get help', icon: 'circle-help', onPress: () => router.push('/ask') },
];

// The spec's menu shadow is `0 12px 32px rgba(23,41,74,0.14)`. On iOS RN's
// shadowRadius IS the blur radius in points, so it maps ~1:1 to CSS blur — 32 mirrors
// the spec directly (was 20, too tight). shadowOffset y:12 and opacity 0.14 carry the
// rest verbatim; Android has no blur control, so elevation (its coarse analog) is
// nudged 12→16 to read as the same soft, lifted card.
const MENU_SHADOW = {
  shadowOpacity: 0.14,
  shadowRadius: 32,
  shadowOffset: { width: 0, height: 12 },
  elevation: 16,
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
        {/* The scrim and the menu are SIBLINGS (not parent/child): the scrim is the
            tap-to-dismiss button filling the modal, the menu floats on top as the next
            sibling so its rows aren't DOM-nested inside the scrim button (a button can't
            contain a button on web). */}
        <Pressable
          className="flex-1"
          accessibilityRole="button"
          accessibilityLabel="Close menu"
          onPress={() => setOpen(false)}
        />
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
              className={`min-h-11 flex-row items-center gap-2.5 px-3.5 py-3 active:opacity-70 ${
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
      </Modal>
    </View>
  );
}
