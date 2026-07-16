import { PUNCH_LABELS, type PunchType } from '@fermosa/shared';
import { router, useLocalSearchParams } from 'expo-router';
import { useRef, useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text, View } from 'react-native';
import { SelfieCamera } from '@/components/SelfieCamera';
import { useAuth } from '@/lib/auth';
import { getRequiredLocation, recordPunch, type RequiredLocation } from '@/lib/punchQueue';

/** Selfie step for clock in/out in personal mode. */
export default function SelfiePunchScreen() {
  const { type, branchId } = useLocalSearchParams<{ type: PunchType; branchId?: string }>();
  const { branch } = useAuth();
  const [saving, setSaving] = useState(false);
  // Required GPS: start the read now so it resolves while the selfie is taken.
  // One-shot fix; the GPS releases itself afterwards.
  const locationReq = useRef<Promise<RequiredLocation> | null>(null);
  if (!locationReq.current) locationReq.current = getRequiredLocation();

  const punchType: PunchType = type === 'clock_out' ? 'clock_out' : 'clock_in';

  const onCapture = async (selfieB64: string | null) => {
    setSaving(true);
    const res = await (locationReq.current ?? getRequiredLocation());
    if (!res.ok) {
      setSaving(false);
      Alert.alert(
        'Location required',
        'Your location is required to time in — turn on Location, allow this app to use it, and try again.',
        [
          { text: 'Cancel', style: 'cancel', onPress: () => router.back() },
          {
            text: 'Try again',
            onPress: () => {
              locationReq.current = getRequiredLocation();
              void onCapture(selfieB64);
            },
          },
        ],
      );
      return;
    }
    // branchId param carries a roving employee's picked branch; the home
    // branch stays the fallback for regular employees.
    await recordPunch(punchType, branchId || branch?.id || null, selfieB64, res.fix);
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
