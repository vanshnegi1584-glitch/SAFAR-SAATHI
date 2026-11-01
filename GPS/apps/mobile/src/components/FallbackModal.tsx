import { Modal, StyleSheet, Text, View } from 'react-native';
import { useSession } from '@/store/session';
import { Button, colors } from './ui';

/** Blueprint §5.1 "Fallback Alert modal" — shown when the last bus on the student's route has left. */
export function FallbackModal() {
  const fallback = useSession((s) => s.fallback);
  const setFallback = useSession((s) => s.setFallback);
  const followTrip = useSession((s) => s.followTrip);

  return (
    <Modal visible={fallback !== null} transparent animationType="slide" onRequestClose={() => setFallback(null)}>
      <View style={styles.backdrop}>
        <View style={styles.sheet} accessibilityViewIsModal>
          <Text style={styles.kicker}>LAST BUS HAS LEFT</Text>
          {fallback && (
            <>
              <Text style={styles.title}>Take {fallback.route_name} instead</Text>
              <Text style={styles.body}>
                Get off at <Text style={styles.bold}>{fallback.stop_name}</Text> —{' '}
                {(fallback.distance_meters / 1000).toFixed(1)} km from your home.
              </Text>
              <Text style={styles.body}>{fallback.available_seats} seats free right now.</Text>
              <Button label="Track this bus" onPress={() => followTrip(fallback.trip_id, fallback.stop_id)} big />
            </>
          )}
          <Button label="Dismiss" tone="ghost" onPress={() => setFallback(null)} />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(15,23,42,0.5)' },
  sheet: { backgroundColor: '#fff', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, gap: 12 },
  kicker: { color: colors.red, fontWeight: '800', letterSpacing: 1 },
  title: { fontSize: 24, fontWeight: '800', color: colors.ink },
  body: { fontSize: 16, color: colors.ink },
  bold: { fontWeight: '700' },
});
