import type { ReactElement, ReactNode } from 'react';
import { type RefreshControlProps, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

type ScreenProps = {
  children: ReactNode;
  scroll?: boolean;
  className?: string;
  refreshControl?: ReactElement<RefreshControlProps>;
};

export function Screen({ children, scroll = false, className, refreshControl }: ScreenProps) {
  const padding = 'px-5 pt-2 pb-6';
  return (
    <SafeAreaView className="flex-1 bg-canvas" edges={['top', 'left', 'right']}>
      {scroll ? (
        <ScrollView
          className="flex-1"
          contentContainerClassName={`${padding} ${className ?? ''}`}
          showsVerticalScrollIndicator={false}
          refreshControl={refreshControl}
        >
          {children}
        </ScrollView>
      ) : (
        <View className={`flex-1 ${padding} ${className ?? ''}`}>{children}</View>
      )}
    </SafeAreaView>
  );
}
