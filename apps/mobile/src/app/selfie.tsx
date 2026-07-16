import { PUNCH_LABELS, type PunchType } from '@fermosa/shared';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { SelfieCamera } from '@/components/SelfieCamera';
import { useAuth } from '@/lib/auth';
import { recordPunch } from '@/lib/punchQueue';

/** Selfie step for clock in/out in personal mode. */
export default function SelfiePunchScreen() {
  const { type, branchId } = useLocalSearchParams<{ type: PunchType; branchId?: string }>();
  const { branch } = useAuth();
  const [saving, setSaving] = useState(false);

  const punchType: PunchType = type === 'clock_out' ? 'clock_out' : 'clock_in';

  const onCapture = async (selfieB64: string | null) => {
    setSaving(true);
    // branchId param carries a roving employee's picked branch; the home
    // branch stays the fallback for regular employees.
    await recordPunch(punchType, branchId || branch?.id || null, selfieB64);
    router.back();
  };

  if (saving) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#D9A400" />
        <Text style={styles.note}>Saving punch…</Text>
      </View>
    );
  }

  return (
    <SelfieCamera
      title={PUNCH_LABELS[punchType]}
      onCapture={onCapture}
      onCancel={() => router.back()}
    />
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 12, backgroundColor: '#f9fafb' },
  note: { fontSize: 14, color: '#6b7280' },
});
