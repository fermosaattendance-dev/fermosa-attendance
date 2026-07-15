import {
  COMPANY_WIDE_ROLES,
  PUNCH_LABELS,
  SELFIE_PUNCH_TYPES,
  checkGeofence,
  nextAllowedPunchTypes,
  workStatusFromLastPunch,
  type PunchType,
} from '@fermosa/shared';
import * as Network from 'expo-network';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AppState,
  FlatList,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { pendingCount, punchesSince, type LocalPunch } from '@/lib/db';
import { recordPunch, syncPending } from '@/lib/punchQueue';
import { formatClock, formatDate, formatPunchTime, recentWindowStartIso } from '@/lib/time';
import { useAuth } from '@/lib/auth';
import { colors, logoMark } from '@/theme';

const STATUS_TEXT = {
  clocked_out: { label: 'Clocked out', color: '#6b7280' },
  working: { label: 'Working', color: '#15803d' },
  on_break: { label: 'On break', color: '#b45309' },
} as const;

const SYNC_BADGE: Record<LocalPunch['sync_status'], { label: string; color: string }> = {
  pending_sync: { label: '📱 Pending sync', color: '#b45309' },
  syncing: { label: '⏳ Syncing…', color: '#0369a1' },
  synced: { label: '✅ Synced', color: '#15803d' },
  failed: { label: '⚠️ Will retry', color: '#b91c1c' },
};

export default function HomeScreen() {
  const { profile, branch, signOut } = useAuth();
  const [now, setNow] = useState(() => new Date());
  const [punches, setPunches] = useState<LocalPunch[]>([]);
  const [pending, setPending] = useState(0);
  const [busy, setBusy] = useState(false);
  const [lastGpsNote, setLastGpsNote] = useState<string | null>(null);
  const online = useRef(true);

  const refresh = useCallback(() => {
    // Rolling window (not the calendar day) so an overnight shift keeps its
    // clocked-in state across midnight.
    setPunches(punchesSince(recentWindowStartIso()));
    setPending(pendingCount());
  }, []);

  const syncAndRefresh = useCallback(async () => {
    await syncPending();
    refresh();
  }, [refresh]);

  // Live clock.
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  // Initial load + sync.
  useEffect(() => {
    refresh();
    void syncAndRefresh();
  }, [refresh, syncAndRefresh]);

  // Coming back from the selfie screen: pick up the new punch immediately.
  useFocusEffect(
    useCallback(() => {
      refresh();
      void syncAndRefresh();
    }, [refresh, syncAndRefresh]),
  );

  // Sync when connectivity returns.
  useEffect(() => {
    const sub = Network.addNetworkStateListener((state) => {
      const isOnline = !!state.isConnected && !!state.isInternetReachable;
      if (isOnline && !online.current) void syncAndRefresh();
      online.current = isOnline;
    });
    return () => sub.remove();
  }, [syncAndRefresh]);

  // Sync when the app returns to the foreground.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') void syncAndRefresh();
    });
    return () => sub.remove();
  }, [syncAndRefresh]);

  // Retry loop while anything is pending.
  useEffect(() => {
    if (pending === 0) return;
    const t = setInterval(() => void syncAndRefresh(), 30_000);
    return () => clearInterval(t);
  }, [pending, syncAndRefresh]);

  const lastType: PunchType | null =
    punches.length > 0 ? punches[punches.length - 1].type : null;
  const allowed = nextAllowedPunchTypes(lastType);
  const status = STATUS_TEXT[workStatusFromLastPunch(lastType)];

  const onPunch = async (type: PunchType) => {
    if (busy) return;
    // Clock in/out require a selfie: hand off to the camera screen, which
    // records the punch itself. Breaks stay one-tap.
    if (SELFIE_PUNCH_TYPES.includes(type)) {
      router.push({ pathname: '/selfie', params: { type } });
      return;
    }
    setBusy(true);
    try {
      const { gps } = await recordPunch(type, branch?.id ?? null);
      if (gps && branch) {
        const fence = checkGeofence(gps.lat, gps.lng, branch.lat, branch.lng, branch.geofence_radius_m);
        setLastGpsNote(
          fence.inside
            ? `Inside ${branch.name} geofence (${Math.round(fence.distanceM)} m from center)`
            : `⚠️ ${Math.round(fence.distanceM)} m from ${branch.name} — outside geofence, HR will review`,
        );
      } else {
        setLastGpsNote('No GPS fix — punch saved, location review by HR');
      }
      refresh();
    } finally {
      setBusy(false);
    }
  };

  const todayLabel = useMemo(() => formatDate(now), [now]);

  if (!profile) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.center}>
          <Text style={styles.muted}>
            Your account has no employee profile yet. Ask HR to complete your registration.
          </Text>
          <Pressable style={styles.signOut} onPress={signOut}>
            <Text style={styles.signOutText}>Sign out</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.header}>
        <View style={styles.brandRow}>
          <View style={styles.logoBadge}>
            <Image source={logoMark} style={styles.logoImg} resizeMode="contain" />
          </View>
          <View>
            <Text style={styles.appName}>Fermosa</Text>
            <Text style={styles.headerSub}>
              {profile.full_name} · {branch?.name ?? 'No branch'}
            </Text>
          </View>
        </View>
        <Pressable style={styles.signOut} onPress={signOut}>
          <Text style={styles.signOutText}>Sign out</Text>
        </Pressable>
      </View>

      <FlatList
        contentContainerStyle={styles.body}
        data={[...punches].reverse()}
        keyExtractor={(p) => p.client_uuid}
        ListHeaderComponent={
          <>
            <View style={styles.clockCard}>
              <Text style={styles.clock}>{formatClock(now)}</Text>
              <Text style={styles.date}>{todayLabel}</Text>
              <View style={[styles.statusPill, { backgroundColor: `${status.color}18` }]}>
                <Text style={[styles.statusText, { color: status.color }]}>{status.label}</Text>
              </View>
            </View>

            <View style={styles.actions}>
              {allowed.map((type) => (
                <Pressable
                  key={type}
                  onPress={() => onPunch(type)}
                  disabled={busy}
                  style={({ pressed }) => [
                    styles.actionBtn,
                    type === 'clock_in' && styles.btnIn,
                    type === 'clock_out' && styles.btnOut,
                    (type === 'break_start' || type === 'break_end') && styles.btnBreak,
                    (pressed || busy) && { opacity: 0.6 },
                  ]}
                >
                  <Text style={styles.actionText}>{busy ? '…' : PUNCH_LABELS[type]}</Text>
                </Pressable>
              ))}
            </View>

            {lastGpsNote && <Text style={styles.gpsNote}>{lastGpsNote}</Text>}

            <View style={styles.syncRow}>
              <Text style={styles.muted}>
                {pending === 0 ? 'All punches synced' : `${pending} punch(es) waiting to sync`}
              </Text>
              <Pressable onPress={() => void syncAndRefresh()}>
                <Text style={styles.syncNow}>Sync now</Text>
              </Pressable>
            </View>

            <Pressable style={styles.leaveLink} onPress={() => router.push('/leave')}>
              <Text style={styles.leaveLinkText}>🏖️  Leave &amp; balances →</Text>
            </Pressable>

            <Pressable style={styles.leaveLink} onPress={() => router.push('/change-password')}>
              <Text style={styles.leaveLinkText}>🔑  Change password →</Text>
            </Pressable>

            {COMPANY_WIDE_ROLES.includes(profile.role) && (
              <Pressable onPress={() => router.push('/kiosk-setup')}>
                <Text style={styles.kioskLink}>Set up this device as a branch kiosk →</Text>
              </Pressable>
            )}

            <Text style={styles.sectionTitle}>Recent punches</Text>
            {punches.length === 0 && (
              <Text style={[styles.muted, { marginTop: 6 }]}>No recent punches.</Text>
            )}
          </>
        }
        renderItem={({ item }) => {
          const badge = SYNC_BADGE[item.sync_status];
          return (
            <View style={styles.punchRow}>
              <View>
                <Text style={styles.punchType}>{PUNCH_LABELS[item.type]}</Text>
                <Text style={styles.punchTime}>{formatPunchTime(item.happened_at)}</Text>
              </View>
              <View style={styles.punchMeta}>
                <Text style={[styles.badge, { color: badge.color }]}>{badge.label}</Text>
                {item.inside_geofence !== null && (
                  <Text style={styles.fenceNote}>
                    {item.inside_geofence ? '📍 In branch' : `📍 ${Math.round(item.distance_m ?? 0)} m away`}
                  </Text>
                )}
              </View>
            </View>
          );
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.ground },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, gap: 16 },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: colors.gold,
  },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  logoBadge: {
    width: 38,
    height: 38,
    borderRadius: 11,
    backgroundColor: colors.white,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoImg: { width: 28, height: 28, borderRadius: 8 },
  appName: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.white,
    textShadowColor: 'rgba(140,96,0,0.35)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 1,
  },
  headerSub: { fontSize: 12, color: colors.onGold, marginTop: 1 },
  muted: { fontSize: 13, color: '#6b7280', marginTop: 2 },
  signOut: {
    borderWidth: 1,
    borderColor: 'rgba(58,45,6,0.3)',
    backgroundColor: 'rgba(255,255,255,0.25)',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  signOutText: { fontSize: 13, fontWeight: '600', color: colors.onGold },
  body: { padding: 20, paddingBottom: 40 },
  clockCard: {
    backgroundColor: '#fff',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    alignItems: 'center',
    paddingVertical: 24,
  },
  clock: { fontSize: 40, fontWeight: '700', color: '#111827', fontVariant: ['tabular-nums'] },
  date: { fontSize: 14, color: '#6b7280', marginTop: 4 },
  statusPill: { marginTop: 12, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 5 },
  statusText: { fontSize: 14, fontWeight: '600' },
  actions: { flexDirection: 'row', gap: 12, marginTop: 16 },
  actionBtn: {
    flex: 1,
    borderRadius: 14,
    paddingVertical: 18,
    alignItems: 'center',
  },
  btnIn: { backgroundColor: '#15803d' },
  btnOut: { backgroundColor: '#b91c1c' },
  btnBreak: { backgroundColor: '#b45309' },
  actionText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  gpsNote: { marginTop: 12, fontSize: 13, color: '#374151' },
  syncRow: {
    marginTop: 14,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  syncNow: { fontSize: 13, fontWeight: '600', color: colors.goldDeep },
  leaveLink: {
    marginTop: 16,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 16,
    alignItems: 'center',
  },
  leaveLinkText: { fontSize: 15, fontWeight: '600', color: '#111827' },
  kioskLink: { marginTop: 10, fontSize: 13, color: '#9ca3af' },
  sectionTitle: { marginTop: 22, fontSize: 15, fontWeight: '600', color: '#111827' },
  punchRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 12,
    padding: 14,
    marginTop: 8,
  },
  punchType: { fontSize: 15, fontWeight: '600', color: '#111827' },
  punchTime: { fontSize: 13, color: '#6b7280', marginTop: 2 },
  punchMeta: { alignItems: 'flex-end' },
  badge: { fontSize: 12, fontWeight: '600' },
  fenceNote: { fontSize: 12, color: '#6b7280', marginTop: 3 },
});
