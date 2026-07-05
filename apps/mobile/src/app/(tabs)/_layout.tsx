import { Tabs } from 'expo-router/js-tabs';

import { AppTabBar } from '@/components/app-tab-bar';

export default function TabsLayout() {
  return (
    <Tabs screenOptions={{ headerShown: false }} tabBar={(props) => <AppTabBar {...props} />}>
      <Tabs.Screen name="index" options={{ title: 'Home' }} />
      <Tabs.Screen name="companion" options={{ title: 'Companion' }} />
      <Tabs.Screen name="ask" options={{ title: 'Concierge' }} />
      <Tabs.Screen name="village" options={{ title: 'Village' }} />
      <Tabs.Screen name="more" options={{ title: 'More' }} />
    </Tabs>
  );
}
