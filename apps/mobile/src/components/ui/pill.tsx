import { SymbolView, type SymbolViewProps } from 'expo-symbols';
import { Pressable } from 'react-native';

import { useMeadowColor } from '@/constants/meadow';

import { AppText } from './app-text';

type PillProps = {
  label: string;
  icon?: SymbolViewProps['name'];
  onPress?: () => void;
  className?: string;
};

export function Pill({ label, icon, onPress, className }: PillProps) {
  const iconColor = useMeadowColor('ink2');
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      className={`h-11 flex-row items-center justify-center gap-1.5 rounded-full border border-rule bg-card px-4 active:opacity-80 ${className ?? ''}`}
    >
      {icon ? <SymbolView name={icon} size={15} tintColor={iconColor} /> : null}
      <AppText variant="meta" className="text-ink">
        {label}
      </AppText>
    </Pressable>
  );
}
