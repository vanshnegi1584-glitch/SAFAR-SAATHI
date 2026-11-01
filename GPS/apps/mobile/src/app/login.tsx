import type { Me } from '@transitlink/shared';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput } from 'react-native';
import { Button, Card, colors } from '@/components/ui';
import { getAuth, getTracking } from '@/lib/live';
import { useTracking } from '@/store/tracking';

/** Sends a signed-in user to the screen for their role (role comes from the server, not the device). */
export function routeForRole(me: Me) {
  if (me.role === 'driver') return router.replace('/live-driver');
  if (me.role === 'student') return router.replace(me.student_route ? '/live-student' : '/live-route');
  return null;
}

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const setMe = useTracking((s) => s.setMe);
  const me = useTracking((s) => s.me);

  const finish = async () => {
    const who = await getTracking().me();
    setMe(who);
    if (routeForRole(who) === null) setError(`Accounts with the "${who.role}" role use the dispatcher web dashboard, not this app.`);
  };

  // Resume a stored session (refreshing the token if needed).
  useEffect(() => {
    void (async () => {
      try {
        if (await getAuth().restore()) await finish();
      } catch (e) {
        setError(String((e as Error).message));
      } finally {
        setBusy(false);
      }
    })();
  }, []);

  const signIn = async () => {
    setBusy(true);
    setError(null);
    try {
      await getAuth().signIn(email.trim(), password);
      await finish();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (busy && !error) return <ActivityIndicator style={{ flex: 1 }} />;

  return (
    <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
      <Text style={styles.h1}>Sign in</Text>
      <Text style={styles.muted}>Use your college account. Your role (student or driver) is set by the transport office.</Text>
      <Card>
        <TextInput style={styles.input} placeholder="Email" autoCapitalize="none" autoComplete="email" keyboardType="email-address" value={email} onChangeText={setEmail} />
        <TextInput style={styles.input} placeholder="Password" secureTextEntry autoComplete="password" value={password} onChangeText={setPassword} />
        {error && <Text style={styles.error}>{error}</Text>}
        <Button label={busy ? 'Signing in…' : 'Sign in'} onPress={signIn} disabled={busy || !email || !password} />
        {me && <Button label="Sign out" tone="ghost" onPress={() => void getAuth().signOut().then(() => { setMe(null); setError(null); })} />}
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: 20, gap: 16, backgroundColor: colors.bg, flexGrow: 1 },
  h1: { fontSize: 28, fontWeight: '800', color: colors.ink },
  muted: { color: colors.muted },
  input: { borderWidth: 1, borderColor: colors.line, borderRadius: 10, padding: 12, fontSize: 16, backgroundColor: '#fff' },
  error: { color: colors.red },
});
