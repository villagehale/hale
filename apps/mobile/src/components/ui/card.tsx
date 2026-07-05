import type { ReactNode } from 'react';
import { Pressable, useColorScheme, View, type ViewProps } from 'react-native';

type CardProps = ViewProps & {
  children: ReactNode;
  raised?: boolean;
  onPress?: () => void;
};

// White-on-off-white (light) needs real depth to separate; on dark, surfaces
// separate by lightness and shadows don't render, so we drop it there. Tuned to
// the web card lift (0 8px 24px rgb(1 32 79 / 0.12)) — a soft Prussian ambient
// shadow, not a hard drop, so cards read as lifted paper.
const LIGHT_SHADOW = {
  shadowColor: '#01204F',
  shadowOpacity: 0.1,
  shadowRadius: 16,
  shadowOffset: { width: 0, height: 6 },
  elevation: 3,
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
