import * as Haptics from 'expo-haptics';
import { useRef } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors } from './ui';

const HOLD_MS = 2000;

/**
 * Giant SOS button (Blueprint §5.1). Press-and-hold for 2 s so a bump or pocket press can't trigger
 * it, while still needing no precise aim — the whole circle is the target.
 */
export function SosButton({ onTrigger, disabled }: { onTrigger: () => void; disabled?: boolean }) {
  const progress = useRef(new Animated.Value(0)).current;
  const anim = useRef<Animated.CompositeAnimation | null>(null);

  const start = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    anim.current = Animated.timing(progress, {
      toValue: 1, duration: HOLD_MS, easing: Easing.linear, useNativeDriver: false,
    });
    anim.current.start(({ finished }) => {
      if (!finished) return;
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      progress.setValue(0);
      onTrigger();
    });
  };

  const cancel = () => {
    anim.current?.stop();
    Animated.timing(progress, { toValue: 0, duration: 150, useNativeDriver: false }).start();
  };

  const fillHeight = progress.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] });

  return (
    <Pressable
      onPressIn={start}
      onPressOut={cancel}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel="SOS emergency alert"
      accessibilityHint="Press and hold for two seconds to alert the dispatcher"
      style={[styles.outer, disabled && { opacity: 0.4 }]}
    >
      <View style={styles.circle}>
        <Animated.View style={[styles.fill, { height: fillHeight }]} />
        <Text style={styles.label}>SOS</Text>
        <Text style={styles.hint}>Hold 2 seconds</Text>
      </View>
    </Pressable>
  );
}

const SIZE = 240;
const styles = StyleSheet.create({
  outer: { alignSelf: 'center', padding: 10, borderRadius: SIZE, backgroundColor: '#fee2e2' },
  circle: {
    width: SIZE, height: SIZE, borderRadius: SIZE / 2, backgroundColor: colors.red,
    alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
  },
  fill: { position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: '#7f1d1d' },
  label: { color: '#fff', fontSize: 64, fontWeight: '900', letterSpacing: 4 },
  hint: { color: '#fecaca', fontWeight: '700' },
});
