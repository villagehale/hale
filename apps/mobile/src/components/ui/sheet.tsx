import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useMeadowColor } from '@/constants/meadow';
import { useReducedMotion } from '@/lib/use-reduced-motion';

import { AppText } from './app-text';
import { Icon } from './icon';

/** The handoff bottom-sheet scrim — a navy-tinted wash (not flat black) that all
 * sheets share. */
const SCRIM = 'rgba(20,28,60,0.35)';

/**
 * The shared bottom-sheet shell (handoff chrome): a transparent slide Modal over a
 * navy scrim, a 28px-rounded card face, a 40×4 grabber, and — when a `title` is
 * given — a serif title row with a circular ✕ close. An inner ScrollView keeps the
 * body reachable above the keyboard. QuickLogModal and the read/act sheets
 * (growth / appointment / village / logs / docs) all render their body inside this
 * so the surface treatment is identical across every Home flow.
 *
 * Dismissal: tap the scrim, the ✕, or the Android hardware back button (Modal
 * onRequestClose). The scrim is a backdrop Pressable that sits BEHIND the sheet card
 * rather than wrapping it, so the card's own scroll/drag gesture is never fought over
 * by a wrapping Pressable (which used to intercept touches meant for the ScrollView).
 * The body scroll adds the bottom safe-area inset so the last control clears the home
 * indicator, and contains its overscroll so a rubber-band never drags the scrim.
 *
 * A future migration to a native form sheet (Modal presentationStyle="formSheet" or a
 * react-navigation form-sheet screen) would hand gestures/detents/keyboard/a11y to the
 * platform — see the PR notes; deferred as a larger, API-shifting change.
 */
export function Sheet({
  visible,
  onClose,
  title,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  /** When set, the sheet renders the handoff title row (serif title + ✕). Omit for
   * a bare sheet whose body supplies its own heading. */
  title?: string;
  children: ReactNode;
}) {
  const closeIcon = useMeadowColor('ink3');
  const insets = useSafeAreaInsets();
  // The handoff sheet slides up (~320ms native). Under Reduce Motion it cross-fades
  // in place instead, dropping the upward travel.
  const reduced = useReducedMotion();
  return (
    <Modal
      visible={visible}
      transparent
      animationType={reduced ? 'fade' : 'slide'}
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        className="flex-1"
      >
        <View className="flex-1 justify-end" style={{ backgroundColor: SCRIM }}>
          {/* Backdrop sits behind the card: tapping the visible scrim closes; taps on
              the card hit the card (topmost) and never reach here. */}
          <Pressable className="absolute inset-0" onPress={onClose} accessibilityLabel="Close" />
          <View className="max-h-[88%] rounded-t-[28px] bg-card">
            <ScrollView
              className="px-5 pt-3.5"
              contentContainerStyle={{ paddingBottom: 32 + insets.bottom }}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
              overScrollMode="never"
            >
              <View className="mb-3.5 h-1 w-10 self-center rounded-full bg-rule" />
              {title ? (
                <View className="mb-4 flex-row items-center justify-between">
                  <AppText variant="title">{title}</AppText>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Close"
                    onPress={onClose}
                    hitSlop={8}
                    className="h-8 w-8 items-center justify-center rounded-full bg-chip-gray active:opacity-80"
                  >
                    <Icon name="x" size={14} color={closeIcon} />
                  </Pressable>
                </View>
              ) : null}
              {children}
            </ScrollView>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
