import type { ReactNode } from 'react';
import { Pressable, useColorScheme, View, type ViewProps } from 'react-native';

type CardProps = ViewProps & {
  children: ReactNode;
  raised?: boolean;
  onPress?: () => void;
};

// White-on-off-white (light) needs real depth to separate; on dark, surfaces
// separate by lightness and shadows don't render, so we drop it there.
const LIGHT_SHADOW = {
  shadowColor: '#0C1626',
  shadowOpacity: 0.06,
  shadowRadius: 12,
  shadowOffset: { width: 0, height: 4 },
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
        className={`${classes} active:opacity-80`}
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
