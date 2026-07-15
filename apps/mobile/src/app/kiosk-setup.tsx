import { COMPANY_WIDE_ROLES } from '@fermosa/shared';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '@/lib/auth';
import { useKiosk } from '@/lib/kiosk';
import { supabase } from '@/lib/supabase';

interface BranchOption {
  id: string;
  name: string;
}

/**
 * Turns THIS device into a branch kiosk. Admin-only; the device key returned
 * by the server is stored on this device and never shown again.
 */
export default function KioskSetupScreen() {
  const { profile } = useAuth();
  const { activateKiosk } = useKiosk();
  const [branches, setBranches] = useState<BranchOption[]>([]);
  const [branchId, setBranchId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isAdmin = profile && COMPANY_WIDE_ROLES.includes(profile.role);

  useEffect(() => {
    supabase.from('branches').select('id, name').eq('is_active', true).order('name')
      .then(({ data }) => setBranches((data as BranchOption[]) ?? []));
  }, []);

  if (!isAdmin) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.center}>
          <Text style={styles.note}>Only HR, operations, or super admin can set up a kiosk.</Text>
          <Pressable style={styles.linkBtn} onPress={() => router.back()}>
            <Text style={styles.link}>Go back</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  const register = async () => {
    if (!branchId || !name.trim()) return;
    setBusy(true);
    setError(null);
    const { data, error: rpcErr } = await supabase.rpc('register_kiosk_device', {
      p_branch_id: branchId,
      p_name: name.trim(),
    });
    setBusy(false);
    if (rpcErr) {
      setError(rpcErr.message);
      return;
    }
    const result = data as { device_id: string; device_key: string };
    const branch = branches.find((b) => b.id === branchId)!;
    activateKiosk({
      device_id: result.device_id,
      device_key: result.device_key,
      branch_id: branchId,
      branch_name: branch.name,
      device_name: name.trim(),
    });
    // KioskProvider flips the navigator into the locked kiosk stack.
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.title}>Set up this device as a kiosk</Text>
        <Text style={styles.note}>
          The app locks into kiosk mode for one branch: staff punch with their employee code, PIN,
          and a selfie. Exiting kiosk mode requires an admin sign-in.
        </Text>

        <Text style={styles.label}>Branch</Text>
        <View style={styles.branchList}>
          {branches.map((b) => (
            <Pressable
              key={b.id}
              onPress={() => setBranchId(b.id)}
              style={[styles.branchItem, branchId === b.id && styles.branchItemActive]}
            >
              <Text style={[styles.branchText, branchId === b.id && styles.branchTextActive]}>
                {b.name}
              </Text>
            </Pressable>
          ))}
        </View>

        <Text style={styles.label}>Device name</Text>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="e.g. Front desk tablet"
          placeholderTextColor="#9ca3af"
          style={styles.input}
        />

        {error && <Text style={styles.error}>{error}</Text>}

        <Pressable
          style={[styles.primaryBtn, (!branchId || !name.trim() || busy) && { opacity: 0.5 }]}
          onPress={register}
          disabled={!branchId || !name.trim() || busy}
        >
          {busy ? <ActivityIndicator color="#fff" /> : (
            <Text style={styles.primaryText}>Activate kiosk mode</Text>
          )}
        </Pressable>

        <Pressable style={styles.linkBtn} onPress={() => router.back()}>
          <Text style={styles.link}>Cancel</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#f9fafb' },
  body: { padding: 24, gap: 10 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, gap: 12 },
  title: { fontSize: 20, fontWeight: '600', color: '#111827' },
  note: { fontSize: 14, color: '#6b7280', lineHeight: 21 },
  label: { fontSize: 14, fontWeight: '500', color: '#374151', marginTop: 14 },
  branchList: { gap: 8 },
  branchItem: {
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
    backgroundColor: '#fff',
  },
  branchItemActive: { borderColor: '#F5C518', backgroundColor: '#FEFBEA' },
  branchText: { fontSize: 15, color: '#374151' },
  branchTextActive: { color: '#B7860B', fontWeight: '700' },
  input: {
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    backgroundColor: '#fff',
    color: '#111827',
  },
  error: { color: '#dc2626', fontSize: 14 },
  primaryBtn: {
    marginTop: 16,
    backgroundColor: '#F5C518',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  primaryText: { color: '#3A2D06', fontSize: 15, fontWeight: '700' },
  linkBtn: { alignItems: 'center', padding: 10 },
  link: { fontSize: 14, color: '#6b7280' },
});
