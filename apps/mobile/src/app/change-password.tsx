import { router } from 'expo-router';
import { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { supabase } from '@/lib/supabase';

export default function ChangePasswordScreen() {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async () => {
    setError(null);
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirm) {
      setError('The two passwords do not match.');
      return;
    }
    setSubmitting(true);
    const { error: updErr } = await supabase.auth.updateUser({ password });
    setSubmitting(false);
    if (updErr) {
      setError(updErr.message);
      return;
    }
    setDone(true);
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <Pressable onPress={() => router.back()} style={styles.back}>
          <Text style={styles.backText}>← Back</Text>
        </Pressable>

        <View style={styles.card}>
          <Text style={styles.title}>Change password</Text>
          <Text style={styles.subtitle}>Set a new password for your account.</Text>

          {done ? (
            <>
              <Text style={styles.success}>✅ Your password has been changed.</Text>
              <Pressable style={styles.button} onPress={() => router.back()}>
                <Text style={styles.buttonText}>Done</Text>
              </Pressable>
            </>
          ) : (
            <>
              <Text style={styles.label}>New password</Text>
              <TextInput
                style={styles.input}
                value={password}
                onChangeText={setPassword}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="at least 8 characters"
                placeholderTextColor="#9ca3af"
              />

              <Text style={styles.label}>Confirm new password</Text>
              <TextInput
                style={styles.input}
                value={confirm}
                onChangeText={setConfirm}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="re-type it"
                placeholderTextColor="#9ca3af"
                onSubmitEditing={onSubmit}
              />

              {error && <Text style={styles.error}>{error}</Text>}

              <Pressable
                style={({ pressed }) => [styles.button, (pressed || submitting) && styles.buttonPressed]}
                onPress={onSubmit}
                disabled={submitting}
              >
                {submitting ? (
                  <ActivityIndicator color="#3A2D06" />
                ) : (
                  <Text style={styles.buttonText}>Save new password</Text>
                )}
              </Pressable>
            </>
          )}
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#F7F6F2' },
  container: { flex: 1, justifyContent: 'center', padding: 24 },
  back: { position: 'absolute', top: 16, left: 20 },
  backText: { color: '#B7860B', fontSize: 15, fontWeight: '600' },
  card: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 24,
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 3,
  },
  title: { fontSize: 22, fontWeight: '600', color: '#111827' },
  subtitle: { marginTop: 4, fontSize: 14, color: '#6b7280', marginBottom: 8 },
  label: { fontSize: 14, fontWeight: '500', color: '#374151', marginTop: 12 },
  input: {
    marginTop: 6,
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: '#111827',
  },
  error: { marginTop: 12, color: '#dc2626', fontSize: 14 },
  success: { marginTop: 16, color: '#15803d', fontSize: 15, fontWeight: '500' },
  button: {
    marginTop: 20,
    backgroundColor: '#F5C518',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  buttonPressed: { opacity: 0.7 },
  buttonText: { color: '#3A2D06', fontSize: 15, fontWeight: '700' },
});
