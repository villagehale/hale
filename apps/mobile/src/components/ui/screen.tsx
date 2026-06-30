import type { ReactNode } from 'react';
import { ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

type ScreenProps = {
  children: ReactNode;
  scroll?: boolean;
  className?: string;
};

export function Screen({ children, scroll = false, className }: ScreenProps) {
  const padding = 'px-5 pt-2 pb-6';
  return (
    <SafeAreaView className="flex-1 bg-canvas" edges={['top', 'left', 'right']}>
      {scroll ? (
        <ScrollView
          className="flex-1"
          contentContainerClassName={`${padding} ${className ?? ''}`}
          showsVerticalScrollIndicator={false}
        >
          {children}
        </ScrollView>
      ) : (
        <View className={`flex-1 ${padding} ${className ?? ''}`}>{children}</View>
      )}
    </SafeAreaView>
  );
}
