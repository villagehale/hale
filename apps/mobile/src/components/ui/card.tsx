import type { ReactNode } from 'react';
import { Pressable, View, type ViewProps } from 'react-native';

type CardProps = ViewProps & {
  children: ReactNode;
  raised?: boolean;
  onPress?: () => void;
};

export function Card({ children, raised = false, onPress, className, style, ...rest }: CardProps) {
  const surface = raised ? 'bg-raised' : 'bg-card';
  const classes = `${surface} rounded-lg border border-rule p-4 ${className ?? ''}`;

  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        className={`${classes} active:opacity-80`}
        style={style}
        {...(rest as object)}
      >
        {children}
      </Pressable>
    );
  }

  return (
    <View className={classes} style={style} {...rest}>
      {children}
    </View>
  );
}
