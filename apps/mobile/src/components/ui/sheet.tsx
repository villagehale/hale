import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, View } from 'react-native';

import { useMeadowColor } from '@/constants/meadow';

import { AppText } from './app-text';
import { Icon } from './icon';

/** The handoff bottom-sheet scrim — a navy-tinted wash (not flat black) that all
 * sheets share. */
const SCRIM = 'rgba(20,28,60,0.35)';

/**
 * The shared bottom-sheet shell (handoff chrome): a transparent slide Modal over a
 * navy scrim, a 28px-rounded white face, a 40×4 grabber, and — when a `title` is
 * given — a serif title row with a circular ✕ close. An inner ScrollView keeps the
 * body reachable above the keyboard. QuickLogModal and the read/act sheets
 * (growth / appointment / village / logs / docs) all render their body inside this
 * so the surface treatment is identical across every Home flow.
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
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        className="flex-1"
      >
        <Pressable
          className="flex-1 justify-end"
          style={{ backgroundColor: SCRIM }}
          onPress={onClose}
          accessibilityLabel="Close"
        >
          <Pressable
            onPress={(e) => e.stopPropagation()}
            className="max-h-[88%] rounded-t-[28px] bg-card"
          >
            <ScrollView
              className="px-5 pt-3.5"
              contentContainerClassName="pb-8"
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              <View className="mb-3.5 h-1 w-10 self-center rounded-full bg-rule" />
              {title ? (
                <View className="mb-4 flex-row items-center justify-between">
                  <AppText variant="title">{title}</AppText>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Close"
                    onPress={onClose}
                    className="h-8 w-8 items-center justify-center rounded-full bg-chip-gray active:opacity-80"
                  >
                    <Icon name="x" size={14} color={closeIcon} />
                  </Pressable>
                </View>
              ) : null}
              {children}
            </ScrollView>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}
