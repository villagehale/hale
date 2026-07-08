import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, View } from 'react-native';

/**
 * The shared bottom-sheet shell, factored from QuickLogModal's blueprint: a
 * transparent slide Modal with a pressable backdrop (tap to dismiss), a rounded
 * top, and an inner ScrollView so content stays reachable above the keyboard. The
 * detail sheets (logs / appointment / village) render their body inside this so
 * the surface treatment is identical across every Home flow. QuickLogModal keeps
 * its own copy (it wires a keyboard-avoiding form); this is for the read/act sheets.
 */
export function Sheet({
  visible,
  onClose,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        className="flex-1"
      >
        <Pressable
          className="flex-1 justify-end bg-black/40"
          onPress={onClose}
          accessibilityLabel="Close"
        >
          <Pressable
            onPress={(e) => e.stopPropagation()}
            className="max-h-[88%] rounded-t-[28px] border-t border-rule bg-canvas"
          >
            <ScrollView
              className="px-5 pt-3"
              contentContainerClassName="pb-8"
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              <View className="mb-5 h-1.5 w-10 self-center rounded-full bg-rule-strong" />
              {children}
            </ScrollView>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}
