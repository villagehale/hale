import type { ReactNode } from 'react';
import { Pressable, useColorScheme, View, type ViewProps } from 'react-native';

type CardProps = ViewProps & {
  children: ReactNode;
  raised?: boolean;
  onPress?: () => void;
};

// White cards on the warm off-white (light) need real depth to separate; on dark,
// surfaces separate by lightness and shadows don't render, so we drop it there. A
// soft, wide Prussian ambient shadow — low opacity, generous blur, small offset —
// so cards read as lifted paper (Apple-like), not a hard drop.
const LIGHT_SHADOW = {
  shadowColor: '#0d1b3d',
  shadowOpacity: 0.08,
  shadowRadius: 20,
  shadowOffset: { width: 0, height: 8 },
  elevation: 2,
} as const;

export function Card({ children, raised = false, onPress, className, style, ...rest }: CardProps) {
  const surface = raised ? 'bg-raised' : 'bg-card';
  const classes = `${surface} rounded-lg border border-rule p-4 ${className ?? ''}`;
  const elevation = useColorScheme() === 'dark' ? null : LIGHT_SHADOW;

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
