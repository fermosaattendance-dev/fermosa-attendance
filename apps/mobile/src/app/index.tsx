import {
  BREAKS_ENABLED,
  COMPANY_WIDE_ROLES,
  PUNCH_LABELS,
  SELFIE_PUNCH_TYPES,
  checkGeofence,
  isLeaveEligible,
  nextAllowedPunchTypes,
  workStatusFromLastPunch,
  type PunchType,
} from '@fermosa/shared';
import * as Network from 'expo-network';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  AppState,
  FlatList,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { kvGetSync, kvRemoveSync, kvSetSync, pendingCount, punchesSince, type LocalPunch } from '@/lib/db';
import { recordPunch, syncPending } from '@/lib/punchQueue';
import { supabase } from '@/lib/supabase';
import { formatClock, formatDate, formatPunchTime, recentWindowStartIso } from '@/lib/time';
import { useAuth, type BranchSummary } from '@/lib/auth';
import { colors, logoMark } from '@/theme';

const STATUS_TEXT = {
  clocked_out: { label: 'Timed out', color: '#6b7280' },
  working: { label: 'Working', color: '#15803d' },
  on_break: { label: 'On break', color: '#b45309' },
} as const;

const hireDateFmt = new Intl.DateTimeFormat('en-PH', {
  timeZone: 'Asia/Manila',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});
const manilaYmdFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' });

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
  // Roving employees (no home branch) pick which branch they're at; the
  // choice is remembered on this device (coords included, so the geofence
  // hint works offline).
  const [rovingBranch, setRovingBranch] = useState<BranchSummary | null>(null);
  const [branchOptions, setBranchOptions] = useState<BranchSummary[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);

  const isRoving = !!profile && !profile.branch_id;
  const activeBranch = branch ?? rovingBranch;

  // Restore the remembered roving branch (works offline).
  useEffect(() => {
    if (!profile || profile.branch_id) return;
    const raw = kvGetSync(`roving_branch.${profile.id}`);
    if (!raw) return;
    try {
      const b = JSON.parse(raw) as BranchSummary;
      if (b?.id) setRovingBranch(b);
    } catch {
      // corrupt value — user just picks again
    }
  }, [profile]);

  // Load the active branch list to pick from; drop a remembered branch that
  // has been deactivated.
  useEffect(() => {
    if (!isRoving || !profile) return;
    supabase
      .from('branches')
      .select('id, name, address, geofence_radius_m, lat, lng, timezone')
      .eq('is_active', true)
      .order('name')
      .then(({ data }) => {
        const opts = (data as BranchSummary[] | null) ?? [];
        if (!opts.length) return;
        setBranchOptions(opts);
        setRovingBranch((cur) => {
          if (cur && !opts.some((o) => o.id === cur.id)) {
            kvRemoveSync(`roving_branch.${profile.id}`);
            return null;
          }
          return cur;
        });
      });
  }, [isRoving, profile]);

  const pickRovingBranch = (b: BranchSummary) => {
    if (!profile) return;
    setRovingBranch(b);
    kvSetSync(`roving_branch.${profile.id}`, JSON.stringify(b));
    setPickerOpen(false);
  };

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

  // Birthday greeting — once per day when today (Manila) matches the birthday.
  useEffect(() => {
    if (!profile?.birthday) return;
    const todayYmd = manilaYmdFmt.format(new Date());
    if (profile.birthday.slice(5) !== todayYmd.slice(5)) return; // compare MM-DD
    const key = `bday_seen.${profile.id}`;
    if (kvGetSync(key) === todayYmd) return;
    kvSetSync(key, todayYmd);
    const perk = isLeaveEligible(profile.employment_status)
      ? " Enjoy your day — don't forget your birthday leave this month 🎁"
      : ' Enjoy your day! 🎁';
    Alert.alert(
      `🎂 Happy Birthday, ${profile.full_name.split(' ')[0]}!`,
      `Wishing you a wonderful year ahead from the whole Fermosa team.${perk}`,
    );
  }, [profile?.id, profile?.birthday]);

  const lastType: PunchType | null =
    punches.length > 0 ? punches[punches.length - 1].type : null;
  const workStatus = workStatusFromLastPunch(lastType);
  // Breaks are hidden for now — the engine deducts the 60-min break
  // automatically on days over 5 h (see BREAKS_ENABLED in shared).
  const allowed: PunchType[] = BREAKS_ENABLED
    ? nextAllowedPunchTypes(lastType)
    : workStatus === 'clocked_out'
      ? ['clock_in']
      : ['clock_out'];
  const status = STATUS_TEXT[workStatus];

  const onPunch = async (type: PunchType) => {
    if (busy) return;
    if (isRoving && !activeBranch) return; // must pick a branch first
    // Clock in/out require a selfie: hand off to the camera screen, which
    // records the punch itself. Breaks stay one-tap.
    if (SELFIE_PUNCH_TYPES.includes(type)) {
      router.push({ pathname: '/selfie', params: { type, branchId: activeBranch?.id ?? '' } });
      return;
    }
    setBusy(true);
    try {
      const { gps } = await recordPunch(type, activeBranch?.id ?? null);
      if (gps && activeBranch) {
        const fence = checkGeofence(gps.lat, gps.lng, activeBranch.lat, activeBranch.lng, activeBranch.geofence_radius_m);
        setLastGpsNote(
          fence.inside
            ? `Inside ${activeBranch.name} geofence (${Math.round(fence.distanceM)} m from center)`
            : `⚠️ ${Math.round(fence.distanceM)} m from ${activeBranch.name} — outside geofence, HR will review`,
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
              {profile.full_name} · {activeBranch?.name ?? (isRoving ? 'Pick a branch' : 'No branch')}
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
              {profile?.date_hired && (
                <Text style={styles.hired}>Hired {hireDateFmt.format(new Date(profile.date_hired))}</Text>
              )}
            </View>

            {isRoving && (
              <View style={styles.rovingCard}>
                {rovingBranch && !pickerOpen ? (
                  <View style={styles.rovingRow}>
                    <Text style={styles.rovingLabel}>
                      📍 Working at: <Text style={styles.rovingName}>{rovingBranch.name}</Text>
                    </Text>
                    <Pressable onPress={() => setPickerOpen(true)} hitSlop={10}>
                      <Text style={styles.rovingChange}>Change</Text>
                    </Pressable>
                  </View>
                ) : (
                  <>
                    <Text style={styles.rovingTitle}>Which branch are you at today?</Text>
                    {branchOptions.length === 0 && (
                      <Text style={styles.muted}>
                        Connect to the internet once to load the branch list.
                      </Text>
                    )}
                    {branchOptions.map((b) => (
                      <Pressable
                        key={b.id}
                        onPress={() => pickRovingBranch(b)}
                        style={[
                          styles.branchOption,
                          rovingBranch?.id === b.id && styles.branchOptionActive,
                        ]}
                      >
                        <Text style={styles.branchOptionText}>{b.name}</Text>
                      </Pressable>
                    ))}
                  </>
                )}
              </View>
            )}

            <View style={styles.actions}>
              {allowed.map((type) => (
                <Pressable
                  key={type}
                  onPress={() => onPunch(type)}
                  disabled={busy || (isRoving && !rovingBranch)}
                  style={({ pressed }) => [
                    styles.actionBtn,
                    type === 'clock_in' && styles.btnIn,
                    type === 'clock_out' && styles.btnOut,
                    (type === 'break_start' || type === 'break_end') && styles.btnBreak,
                    (pressed || busy || (isRoving && !rovingBranch)) && { opacity: 0.6 },
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

            {profile && isLeaveEligible(profile.employment_status) && (
              <Pressable style={styles.leaveLink} onPress={() => router.push('/leave')}>
                <Text style={styles.leaveLinkText}>🏖️  Leave &amp; balances →</Text>
              </Pressable>
            )}

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
  hired: { fontSize: 12, color: '#9ca3af', marginTop: 8 },
  statusPill: { marginTop: 12, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 5 },
  statusText: { fontSize: 14, fontWeight: '600' },
  rovingCard: {
    backgroundColor: '#fff',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    padding: 14,
    marginTop: 16,
    gap: 8,
  },
  rovingRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  rovingLabel: { fontSize: 14, color: '#374151' },
  rovingName: { fontWeight: '700', color: '#111827' },
  rovingChange: { fontSize: 13, fontWeight: '600', color: colors.goldDeep },
  rovingTitle: { fontSize: 15, fontWeight: '600', color: '#111827' },
  branchOption: {
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  branchOptionActive: { borderColor: colors.gold, backgroundColor: '#FEFBEA' },
  branchOptionText: { fontSize: 15, fontWeight: '500', color: '#111827' },
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
