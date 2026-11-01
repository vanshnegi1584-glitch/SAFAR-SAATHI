import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';

export const colors = {
  ink: '#0f172a',
  muted: '#64748b',
  line: '#e2e8f0',
  bg: '#f8fafc',
  primary: '#2563eb',
  green: '#16a34a',
  amber: '#d97706',
  red: '#dc2626',
};

export function Card({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Button({
  label, onPress, tone = 'primary', disabled, big,
}: { label: string; onPress: () => void; tone?: 'primary' | 'ghost' | 'danger' | 'green'; disabled?: boolean; big?: boolean }) {
  const bg = { primary: colors.primary, ghost: 'transparent', danger: colors.red, green: colors.green }[tone];
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.btn,
        { backgroundColor: bg, opacity: disabled ? 0.4 : pressed ? 0.8 : 1 },
        tone === 'ghost' && styles.ghost,
        big && styles.big,
      ]}
    >
      <Text style={[styles.btnText, tone === 'ghost' && { color: colors.ink }, big && { fontSize: 20 }]}>{label}</Text>
    </Pressable>
  );
}

export function Chip({ label, selected, onPress, color }: { label: string; selected: boolean; onPress: () => void; color?: string }) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[styles.chip, selected && { backgroundColor: colors.ink, borderColor: colors.ink }]}
    >
      {color && <View style={[styles.dot, { backgroundColor: color }]} />}
      <Text style={[styles.chipText, selected && { color: '#fff' }]}>{label}</Text>
    </Pressable>
  );
}

export function Badge({ label, color }: { label: string; color: string }) {
  return (
    <View style={[styles.badge, { backgroundColor: color }]}>
      <Text style={styles.badgeText}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#fff', borderRadius: 16, padding: 16, gap: 8,
    shadowColor: '#000', shadowOpacity: 0.08, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 3,
  },
  btn: { borderRadius: 12, paddingVertical: 14, paddingHorizontal: 16, alignItems: 'center' },
  ghost: { borderWidth: 1, borderColor: colors.line },
  big: { paddingVertical: 20 },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderColor: colors.line,
    borderRadius: 999, paddingVertical: 8, paddingHorizontal: 14, backgroundColor: '#fff',
  },
  chipText: { color: colors.ink, fontWeight: '600' },
  dot: { width: 10, height: 10, borderRadius: 5 },
  badge: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3, alignSelf: 'flex-start' },
  badgeText: { color: '#fff', fontSize: 11, fontWeight: '800' },
});
