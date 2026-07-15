import {
  COMPANY_WIDE_ROLES,
  PUNCH_LABELS,
  type PunchType,
  type Role,
} from '@fermosa/shared';
import * as Crypto from 'expo-crypto';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { SelfieCamera } from '@/components/SelfieCamera';
import { kioskPunch, useKiosk } from '@/lib/kiosk';
import { tryGetLocation } from '@/lib/punchQueue';
import { supabase } from '@/lib/supabase';

type Step =
  | { name: 'idle' }
  | { name: 'credentials' }
  | { name: 'punch_type'; code: string; pin: string }
  | { name: 'selfie'; code: string; pin: string; type: PunchType }
  | { name: 'submitting' }
  | { name: 'result'; ok: boolean; message: string }
  | { name: 'exit' };

const PUNCH_TYPES: PunchType[] = ['clock_in', 'break_start', 'break_end', 'clock_out'];

export default function KioskScreen() {
  const { kiosk, deactivateKiosk } = useKiosk();
  const [step, setStep] = useState<Step>({ name: 'idle' });
  const [code, setCode] = useState('');
  const [pin, setPin] = useState('');
  const [exitEmail, setExitEmail] = useState('');
  const [exitPassword, setExitPassword] = useState('');
  const [exitError, setExitError] = useState<string | null>(null);
  const [exitBusy, setExitBusy] = useState(false);

  // A kiosk terminal never keeps a personal session.
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) void supabase.auth.signOut();
    });
  }, []);

  if (!kiosk) return null;

  const submit = async (punchCode: string, punchPin: string, type: PunchType, selfieB64: string | null) => {
    setStep({ name: 'submitting' });
    const gps = await tryGetLocation();
    const result = await kioskPunch({
      kiosk,
      employeeCode: punchCode,
      pin: punchPin,
      type,
      clientUuid: Crypto.randomUUID(),
      selfieB64,
      lat: gps?.lat ?? null,
      lng: gps?.lng ?? null,
      gpsAccuracyM: gps?.accuracy ?? null,
    });
    if (result.ok) {
      const fence =
        result.inside_geofence === false
          ? ' (outside branch geofence — HR will review)'
          : '';
      setStep({
        name: 'result',
        ok: true,
        message: `${result.employee_name}: ${PUNCH_LABELS[type]} recorded${fence}`,
      });
    } else {
      setStep({ name: 'result', ok: false, message: result.error ?? 'Punch failed — try again' });
    }
    setTimeout(() => setStep({ name: 'idle' }), 3500);
  };

  const tryExit = async () => {
    setExitBusy(true);
    setExitError(null);
    const { data, error } = await supabase.auth.signInWithPassword({
      email: exitEmail.trim(),
      password: exitPassword,
    });
    if (error || !data.user) {
      setExitBusy(false);
      setExitError(error?.message ?? 'Sign-in failed');
      return;
    }
    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', data.user.id)
      .maybeSingle();
    setExitBusy(false);
    if (!profile || !COMPANY_WIDE_ROLES.includes(profile.role as Role)) {
      await supabase.auth.signOut();
      setExitError('Only HR, operations, or super admin can exit kiosk mode.');
      return;
    }
    deactivateKiosk(); // admin stays signed in; navigator returns to personal mode
  };

  if (step.name === 'selfie') {
    return (
      <SelfieCamera
        title={`${PUNCH_LABELS[step.type]} — look at the camera`}
        onCapture={(b64) => void submit(step.code, step.pin, step.type, b64)}
        onCancel={() => setStep({ name: 'idle' })}
      />
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.header}>
        <View>
          <Text style={styles.branch}>{kiosk.branch_name}</Text>
          <Text style={styles.deviceName}>{kiosk.device_name} · Attendance kiosk</Text>
        </View>
        <Pressable onPress={() => setStep({ name: 'exit' })} hitSlop={12}>
          <Text style={styles.exitLink}>Exit</Text>
        </Pressable>
      </View>

      <View style={styles.body}>
        {step.name === 'idle' && (
          <>
            <Text style={styles.bigTitle}>Tap to punch</Text>
            <Pressable
              style={styles.bigBtn}
              onPress={() => {
                setCode('');
                setPin('');
                setStep({ name: 'credentials' });
              }}
            >
              <Text style={styles.bigBtnText}>Start</Text>
            </Pressable>
          </>
        )}

        {step.name === 'credentials' && (
          <View style={styles.form}>
            <Text style={styles.formTitle}>Enter your details</Text>
            <TextInput
              value={code}
              onChangeText={setCode}
              placeholder="Employee code (e.g. FSC-0005)"
              placeholderTextColor="#9ca3af"
              autoCapitalize="characters"
              style={styles.input}
            />
            <TextInput
              value={pin}
              onChangeText={(v) => setPin(v.replace(/\D/g, '').slice(0, 6))}
              placeholder="PIN"
              placeholderTextColor="#9ca3af"
              keyboardType="number-pad"
              secureTextEntry
              style={styles.input}
            />
            <Pressable
              style={[styles.primaryBtn, (!code.trim() || pin.length < 4) && { opacity: 0.5 }]}
              disabled={!code.trim() || pin.length < 4}
              onPress={() => setStep({ name: 'punch_type', code: code.trim(), pin })}
            >
              <Text style={styles.primaryText}>Next</Text>
            </Pressable>
            <Pressable style={styles.linkBtn} onPress={() => setStep({ name: 'idle' })}>
              <Text style={styles.link}>Cancel</Text>
            </Pressable>
          </View>
        )}

        {step.name === 'punch_type' && (
          <View style={styles.form}>
            <Text style={styles.formTitle}>What are you doing?</Text>
            {PUNCH_TYPES.map((t) => (
              <Pressable
                key={t}
                style={styles.typeBtn}
                onPress={() => setStep({ name: 'selfie', code: step.code, pin: step.pin, type: t })}
              >
                <Text style={styles.typeText}>{PUNCH_LABELS[t]}</Text>
              </Pressable>
            ))}
            <Pressable style={styles.linkBtn} onPress={() => setStep({ name: 'idle' })}>
              <Text style={styles.link}>Cancel</Text>
            </Pressable>
          </View>
        )}

        {step.name === 'submitting' && (
          <>
            <ActivityIndicator size="large" color="#D9A400" />
            <Text style={styles.note}>Recording punch…</Text>
          </>
        )}

        {step.name === 'result' && (
          <View style={[styles.resultCard, step.ok ? styles.resultOk : styles.resultBad]}>
            <Text style={styles.resultEmoji}>{step.ok ? '✅' : '❌'}</Text>
            <Text style={styles.resultText}>{step.message}</Text>
          </View>
        )}

        {step.name === 'exit' && (
          <View style={styles.form}>
            <Text style={styles.formTitle}>Admin sign-in to exit kiosk</Text>
            <TextInput
              value={exitEmail}
              onChangeText={setExitEmail}
              placeholder="Admin email"
              placeholderTextColor="#9ca3af"
              autoCapitalize="none"
              keyboardType="email-address"
              style={styles.input}
            />
            <TextInput
              value={exitPassword}
              onChangeText={setExitPassword}
              placeholder="Password"
              placeholderTextColor="#9ca3af"
              secureTextEntry
              style={styles.input}
            />
            {exitError && <Text style={styles.error}>{exitError}</Text>}
            <Pressable style={styles.primaryBtn} onPress={tryExit} disabled={exitBusy}>
              {exitBusy ? <ActivityIndicator color="#fff" /> : (
                <Text style={styles.primaryText}>Exit kiosk mode</Text>
              )}
            </Pressable>
            <Pressable style={styles.linkBtn} onPress={() => setStep({ name: 'idle' })}>
              <Text style={styles.link}>Back</Text>
            </Pressable>
          </View>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#F7F6F2' },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingVertical: 16,
  },
  branch: { fontSize: 20, fontWeight: '700', color: '#111827' },
  deviceName: { fontSize: 13, color: '#6b7280', marginTop: 2 },
  exitLink: { fontSize: 13, color: '#9ca3af' },
  body: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, gap: 14 },
  bigTitle: { fontSize: 26, fontWeight: '700', color: '#111827' },
  bigBtn: {
    backgroundColor: '#F5C518',
    borderRadius: 999,
    width: 180,
    height: 180,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bigBtnText: { color: '#3A2D06', fontSize: 28, fontWeight: '700' },
  form: { width: '100%', maxWidth: 420, gap: 12 },
  formTitle: { fontSize: 19, fontWeight: '600', color: '#111827', textAlign: 'center', marginBottom: 6 },
  input: {
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 13,
    fontSize: 17,
    backgroundColor: '#fff',
    color: '#111827',
  },
  primaryBtn: {
    backgroundColor: '#F5C518',
    borderRadius: 12,
    paddingVertical: 15,
    alignItems: 'center',
  },
  primaryText: { color: '#3A2D06', fontSize: 16, fontWeight: '700' },
  typeBtn: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 14,
    paddingVertical: 18,
    alignItems: 'center',
  },
  typeText: { fontSize: 17, fontWeight: '600', color: '#111827' },
  linkBtn: { alignItems: 'center', padding: 8 },
  link: { fontSize: 14, color: '#6b7280' },
  note: { fontSize: 14, color: '#6b7280' },
  error: { color: '#dc2626', fontSize: 14, textAlign: 'center' },
  resultCard: {
    borderRadius: 16,
    paddingVertical: 28,
    paddingHorizontal: 24,
    alignItems: 'center',
    gap: 10,
    width: '100%',
    maxWidth: 420,
  },
  resultOk: { backgroundColor: '#dcfce7' },
  resultBad: { backgroundColor: '#fee2e2' },
  resultEmoji: { fontSize: 40 },
  resultText: { fontSize: 17, fontWeight: '600', color: '#111827', textAlign: 'center' },
});
