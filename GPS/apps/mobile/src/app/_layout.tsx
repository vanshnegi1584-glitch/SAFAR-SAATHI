import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useState } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { LiveTrackingBridge } from '@/components/LiveTrackingBridge';
import { RealtimeBridge } from '@/components/RealtimeBridge';
import { isLive } from '@/lib/live';
import { useTracking } from '@/store/tracking';
import '@/tasks/driverLocation'; // background task must be defined at module load

export default function RootLayout() {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: 2 } } }));
  const signedIn = useTracking((s) => s.me !== null);
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={client}>
        {/* Live mode talks to the tracking server after login; the simulator bridge stays for mock mode. */}
        {isLive() ? signedIn && <LiveTrackingBridge /> : <RealtimeBridge />}
        <StatusBar style="dark" />
        <Stack screenOptions={{ headerTitleStyle: { fontWeight: '700' } }}>
          <Stack.Screen name="index" options={{ title: 'TransitLink' }} />
          <Stack.Screen name="student" options={{ title: 'My Bus', headerBackVisible: false }} />
          <Stack.Screen name="driver" options={{ title: 'Driver', headerBackVisible: false }} />
          <Stack.Screen name="login" options={{ title: 'SafarSaathi', headerBackVisible: false }} />
          <Stack.Screen name="live-route" options={{ title: 'Choose route' }} />
          <Stack.Screen name="live-student" options={{ title: 'My bus', headerBackVisible: false }} />
          <Stack.Screen name="live-driver" options={{ title: 'Driver', headerBackVisible: false }} />
        </Stack>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}
