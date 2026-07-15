import { useState } from 'react';
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { usernameToEmail } from '@fermosa/shared';
import { supabase } from '@/lib/supabase';
import { colors, radius, shadowCard, logoMark } from '@/theme';

export default function LoginScreen() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async () => {
    setError(null);
    setSubmitting(true);
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: usernameToEmail(username),
      password,
    });
    if (signInError) setError(signInError.message);
    setSubmitting(false);
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.hero}>
          <View style={styles.badge}>
            <Image source={logoMark} style={styles.logo} resizeMode="contain" />
          </View>
          <Text style={styles.brand}>Fermosa</Text>
          <Text style={styles.tagline}>SKIN CARE CLINIC</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.title}>Welcome back</Text>
          <Text style={styles.subtitle}>Sign in with your employee account</Text>

          <Text style={styles.label}>Username</Text>
          <TextInput
            style={styles.input}
            value={username}
            onChangeText={setUsername}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="username"
            placeholder="username"
            placeholderTextColor={colors.muted}
          />

          <Text style={styles.label}>Password</Text>
          <TextInput
            style={styles.input}
            value={password}
            onChangeText={setPassword}
            autoComplete="current-password"
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="password"
            placeholderTextColor={colors.muted}
            onSubmitEditing={onSubmit}
          />

          {error && <Text style={styles.error}>{error}</Text>}

          <Pressable
            style={({ pressed }) => [styles.button, (pressed || submitting) && styles.buttonPressed]}
            onPress={onSubmit}
            disabled={submitting}
          >
            {submitting ? (
              <ActivityIndicator color={colors.onGold} />
            ) : (
              <Text style={styles.buttonText}>Sign in</Text>
            )}
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.ground },
  container: { flex: 1, justifyContent: 'center', padding: 24, gap: 20 },
  hero: {
    backgroundColor: colors.gold,
    borderRadius: radius.xl,
    alignItems: 'center',
    paddingVertical: 32,
    paddingHorizontal: 24,
    ...shadowCard,
  },
  badge: {
    width: 76,
    height: 76,
    borderRadius: 20,
    backgroundColor: colors.white,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadowCard,
  },
  logo: { width: 54, height: 54, borderRadius: 12 },
  brand: {
    marginTop: 14,
    fontSize: 32,
    fontWeight: '700',
    color: colors.white,
    textShadowColor: 'rgba(140,96,0,0.35)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
  },
  tagline: {
    marginTop: 6,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 4,
    color: colors.onGold,
  },
  card: { backgroundColor: colors.card, borderRadius: radius.lg, padding: 24, ...shadowCard },
  title: { fontSize: 22, fontWeight: '700', color: colors.ink },
  subtitle: { marginTop: 4, fontSize: 14, color: colors.muted, marginBottom: 8 },
  label: { fontSize: 14, fontWeight: '600', color: colors.ink, marginTop: 12 },
  input: {
    marginTop: 6,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.ground,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: 11,
    fontSize: 15,
    color: colors.ink,
  },
  error: { marginTop: 12, color: colors.bad, fontSize: 14 },
  button: {
    marginTop: 20,
    backgroundColor: colors.gold,
    borderRadius: radius.md,
    paddingVertical: 13,
    alignItems: 'center',
  },
  buttonPressed: { opacity: 0.75 },
  buttonText: { color: colors.onGold, fontSize: 15, fontWeight: '700' },
});
