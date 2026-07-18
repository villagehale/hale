import type { ReactNode } from 'react';
import { Pressable, useColorScheme, View, type ViewProps } from 'react-native';

import { useMeadowColor } from '@/constants/meadow';

type CardProps = ViewProps & {
  children: ReactNode;
  raised?: boolean;
  /** The warm cream highlight card (handoff great-news / trust cards). */
  variant?: 'default' | 'cream';
  onPress?: () => void;
};

// White cards on the warm off-white (light) need real depth to separate; on dark,
// surfaces separate by lightness and shadows don't render, so we drop it there. A
// soft, wide ambient shadow in the ink tone — low opacity, generous blur, small
// offset — so cards read as lifted paper (Apple-like), not a hard drop. The color
// comes from the ink token (handoff shadows are rgba of #17294A).
const LIGHT_SHADOW = {
  shadowOpacity: 0.08,
  shadowRadius: 20,
  shadowOffset: { width: 0, height: 8 },
  elevation: 2,
} as const;

export function Card({
  children,
  raised = false,
  variant = 'default',
  onPress,
  className,
  style,
  ...rest
}: CardProps) {
  const tone =
    variant === 'cream'
      ? 'bg-cream border-cream-border'
      : `${raised ? 'bg-raised' : 'bg-card'} border-rule`;
  const classes = `${tone} rounded-[20px] border p-4 ${className ?? ''}`;
  const shadowColor = useMeadowColor('ink');
  const elevation = useColorScheme() === 'dark' ? null : { ...LIGHT_SHADOW, shadowColor };

  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        className={`${classes} active:opacity-90`}
        style={[elevation, style]}
        {...(rest as object)}
      >
        {children}
      </Pressable>
    );
  }

  return (
    <View className={classes} style={[elevation, style]} {...rest}>
      {children}
    </View>
  );
}
