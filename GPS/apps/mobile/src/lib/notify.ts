import Constants, { ExecutionEnvironment } from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

export const isExpoGo = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;

const CHANNEL = 'transit-alerts';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

let ready: Promise<boolean> | null = null;

/** Creates the Android channel (must precede permission/token requests on Android 13+) and asks permission once. */
export function ensureNotificationPermission(): Promise<boolean> {
  ready ??= (async () => {
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync(CHANNEL, {
        name: 'Bus alerts',
        importance: Notifications.AndroidImportance.HIGH,
      });
    }
    const { granted } = await Notifications.requestPermissionsAsync();
    return granted;
  })();
  return ready;
}

/** Immediate local notification — works in Expo Go. */
export async function notifyNow(title: string, body: string): Promise<void> {
  if (!(await ensureNotificationPermission())) return;
  await Notifications.scheduleNotificationAsync({ content: { title, body }, trigger: null });
}

/**
 * Native FCM (Android) / APNs (iOS) token for the backend's push sender (Blueprint §6).
 * Remote push is unavailable in Expo Go on Android since SDK 53, so this returns null there.
 * Needs a development build with google-services.json configured.
 */
export async function getPushToken(): Promise<string | null> {
  if (isExpoGo || !Device.isDevice) return null;
  if (!(await ensureNotificationPermission())) return null;
  try {
    const token = await Notifications.getDevicePushTokenAsync();
    return typeof token.data === 'string' ? token.data : null;
  } catch (e) {
    console.warn('Push token unavailable', e);
    return null;
  }
}
