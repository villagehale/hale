import { SymbolView, type SymbolViewProps } from 'expo-symbols';
import { Pressable } from 'react-native';

import { useMeadowColor } from '@/constants/meadow';

type IconButtonProps = {
  icon: SymbolViewProps['name'];
  accessibilityLabel: string;
  onPress?: () => void;
  size?: number;
  className?: string;
};

export function IconButton({
  icon,
  accessibilityLabel,
  onPress,
  size = 20,
  className,
}: IconButtonProps) {
  const tint = useMeadowColor('ink2');
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      className={`h-11 w-11 items-center justify-center rounded-full border border-rule bg-card active:opacity-80 ${className ?? ''}`}
    >
      <SymbolView name={icon} size={size} tintColor={tint} />
    </Pressable>
  );
}

export function MicButton({
  accessibilityLabel = 'Voice log',
  onPress,
  size = 22,
  className,
}: Omit<IconButtonProps, 'icon' | 'accessibilityLabel'> & { accessibilityLabel?: string }) {
  const tint = useMeadowColor('canvas');
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      className={`h-12 w-12 items-center justify-center rounded-full bg-accent-fill active:opacity-90 ${className ?? ''}`}
    >
      <SymbolView name="mic.fill" size={size} tintColor={tint} />
    </Pressable>
  );
}
