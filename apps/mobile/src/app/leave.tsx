import { LEAVE_STATUS_LABELS, countLeaveDays, isLeaveEligible, type LeaveStatus } from '@fermosa/shared';
import DateTimePicker from '@react-native-community/datetimepicker';
import { router } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/lib/supabase';

interface TypeRow {
  id: string;
  name: string;
  is_paid: boolean;
  birthday_only: boolean;
}
interface BalanceRow {
  leave_type_id: string;
  entitled_days: number;
  used_days: number;
  remaining_days: number;
}
interface RequestRow {
  id: string;
  start_date: string;
  end_date: string;
  half_day: boolean;
  day_count: number;
  reason: string | null;
  status: LeaveStatus;
  review_note: string | null;
  leave_type: { name: string } | null;
}

const STATUS_COLOR: Record<LeaveStatus, string> = {
  pending: '#b45309',
  approved: '#15803d',
  rejected: '#b91c1c',
  cancelled: '#6b7280',
};

const YEAR = new Date().getFullYear();
const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const fmtDays = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

export default function LeaveScreen() {
  const { profile } = useAuth();
  const [types, setTypes] = useState<TypeRow[]>([]);
  const [balances, setBalances] = useState<BalanceRow[]>([]);
  const [requests, setRequests] = useState<RequestRow[]>([]);
  const [workDays, setWorkDays] = useState<number[]>([1, 2, 3, 4, 5, 6]);
  const [holidays, setHolidays] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  const [typeId, setTypeId] = useState<string | null>(null);
  const [start, setStart] = useState(() => new Date());
  const [end, setEnd] = useState(() => new Date());
  const [halfDay, setHalfDay] = useState(false);
  const [reason, setReason] = useState('');
  const [showStart, setShowStart] = useState(false);
  const [showEnd, setShowEnd] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!profile) return;
    const [t, b, r] = await Promise.all([
      supabase.from('leave_types').select('id, name, is_paid, birthday_only').eq('is_active', true).order('name'),
      supabase
        .from('leave_balances_view')
        .select('leave_type_id, entitled_days, used_days, remaining_days')
        .eq('employee_id', profile.id)
        .eq('year', YEAR),
      supabase
        .from('leave_requests')
        .select('id, start_date, end_date, half_day, day_count, reason, status, review_note, leave_type:leave_types(name)')
        .eq('employee_id', profile.id)
        .order('start_date', { ascending: false })
        .limit(50),
    ]);
    setTypes((t.data as TypeRow[]) ?? []);
    setBalances((b.data as BalanceRow[]) ?? []);
    setRequests((r.data as unknown as RequestRow[]) ?? []);
    if (!typeId && t.data && t.data.length > 0) setTypeId((t.data as TypeRow[])[0].id);

    if (profile.branch_id) {
      const { data: br } = await supabase
        .from('branches')
        .select('work_days')
        .eq('id', profile.branch_id)
        .maybeSingle();
      if (br?.work_days) setWorkDays(br.work_days as number[]);
    }
    const { data: hol } = await supabase
      .from('holidays')
      .select('holiday_date')
      .gte('holiday_date', `${YEAR}-01-01`)
      .lte('holiday_date', `${YEAR}-12-31`);
    setHolidays(((hol as { holiday_date: string }[]) ?? []).map((h) => h.holiday_date));
    setLoading(false);
  }, [profile, typeId]);

  useEffect(() => {
    void load();
  }, [load]);

  const selectedType = types.find((t) => t.id === typeId) ?? null;
  const isBirthdayType = selectedType?.birthday_only ?? false;
  const birthMonth = profile?.birthday ? Number(profile.birthday.slice(5, 7)) : null; // 1–12
  const birthMonthName = birthMonth
    ? new Date(YEAR, birthMonth - 1, 1).toLocaleString('en-US', { month: 'long' })
    : '';
  const singleDay = halfDay || isBirthdayType; // birthday leave is one full day
  const startYmd = ymd(start);
  const endYmd = singleDay ? startYmd : ymd(end);
  // Birthday leave is a fixed 1-day perk on any day in the birth month (rest days
  // included) — it isn't reduced by the working-day count like regular leave.
  const dayCount = useMemo(
    () => (isBirthdayType ? 1 : countLeaveDays(startYmd, endYmd, workDays, holidays, halfDay)),
    [isBirthdayType, startYmd, endYmd, workDays, holidays, halfDay],
  );
  const balanceForType = balances.find((b) => b.leave_type_id === typeId) ?? null;
  const startInBirthMonth =
    !!birthMonth && start.getMonth() + 1 === birthMonth && start.getFullYear() === YEAR;
  const birthdayBlocked = isBirthdayType && (!profile?.birthday || !startInBirthMonth);

  // When Birthday Leave is picked, snap to a single day inside the birth month.
  useEffect(() => {
    if (!isBirthdayType || !birthMonth) return;
    setHalfDay(false);
    if (start.getMonth() + 1 !== birthMonth || start.getFullYear() !== YEAR) {
      setStart(new Date(YEAR, birthMonth - 1, 1));
    }
  }, [isBirthdayType, birthMonth, start]);

  const submit = async () => {
    if (!profile || !typeId) return;
    if (endYmd < startYmd) {
      Alert.alert('Invalid dates', 'The end date is before the start date.');
      return;
    }
    if (isBirthdayType && !profile.birthday) {
      Alert.alert('Birthday needed', 'Ask HR to add your birthday first.');
      return;
    }
    if (isBirthdayType && !startInBirthMonth) {
      Alert.alert('Birth month only', `Birthday leave can only be taken in your birth month (${birthMonthName}).`);
      return;
    }
    setBusy(true);
    const { error } = await supabase.from('leave_requests').insert({
      company_id: profile.company_id,
      employee_id: profile.id,
      leave_type_id: typeId,
      start_date: startYmd,
      end_date: endYmd,
      half_day: halfDay,
      reason: reason.trim() || null,
      status: 'pending',
    });
    setBusy(false);
    if (error) {
      Alert.alert('Could not file leave', error.message);
      return;
    }
    setReason('');
    setHalfDay(false);
    Alert.alert('Leave filed', 'Your request is pending HR approval.');
    void load();
  };

  const cancel = (r: RequestRow) => {
    Alert.alert('Cancel request?', `${r.leave_type?.name ?? 'Leave'} ${r.start_date}`, [
      { text: 'Keep', style: 'cancel' },
      {
        text: 'Cancel request',
        style: 'destructive',
        onPress: async () => {
          const { error } = await supabase.from('leave_requests').update({ status: 'cancelled' }).eq('id', r.id);
          if (error) Alert.alert('Error', error.message);
          else void load();
        },
      },
    ]);
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.center}>
          <ActivityIndicator />
        </View>
      </SafeAreaView>
    );
  }

  // Leave is a regular-employee perk — probationary/other staff have none.
  if (profile && !isLeaveEligible(profile.employment_status)) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()}>
            <Text style={styles.back}>‹ Back</Text>
          </Pressable>
          <Text style={styles.title}>Leave</Text>
          <View style={{ width: 48 }} />
        </View>
        <View style={styles.body}>
          <Text style={styles.muted}>
            Leave becomes available once you’re a regular employee. Check with HR if you have
            questions about your status.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()}>
          <Text style={styles.back}>‹ Back</Text>
        </Pressable>
        <Text style={styles.title}>Leave</Text>
        <View style={{ width: 48 }} />
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.sectionTitle}>Your balances ({YEAR})</Text>
        {balances.length === 0 ? (
          <Text style={styles.muted}>No balances yet. HR sets these up.</Text>
        ) : (
          <View style={styles.balanceRow}>
            {balances.map((b) => {
              const name = types.find((t) => t.id === b.leave_type_id)?.name ?? 'Leave';
              return (
                <View key={b.leave_type_id} style={styles.balanceCard}>
                  <Text style={styles.balanceName}>{name}</Text>
                  <Text style={styles.balanceBig}>{fmtDays(b.remaining_days)}</Text>
                  <Text style={styles.muted}>of {fmtDays(b.entitled_days)} left</Text>
                </View>
              );
            })}
          </View>
        )}

        <Text style={[styles.sectionTitle, { marginTop: 24 }]}>Request leave</Text>
        <View style={styles.card}>
          <Text style={styles.label}>Type</Text>
          <View style={styles.chips}>
            {types.map((t) => (
              <Pressable
                key={t.id}
                onPress={() => setTypeId(t.id)}
                style={[styles.chip, typeId === t.id && styles.chipActive]}
              >
                <Text style={[styles.chipText, typeId === t.id && styles.chipTextActive]}>
                  {t.name}
                  {t.is_paid ? '' : ' (unpaid)'}
                </Text>
              </Pressable>
            ))}
          </View>

          {isBirthdayType && (
            <View style={styles.birthdayHint}>
              <Text style={styles.birthdayHintText}>
                {profile?.birthday
                  ? `🎂 Birthday leave — one paid day, any day in your birth month (${birthMonthName}), rest days included.`
                  : '🎂 Birthday leave — ask HR to add your birthday to your profile first.'}
              </Text>
            </View>
          )}

          <View style={styles.dateRow}>
            <View style={styles.dateCol}>
              <Text style={styles.label}>{isBirthdayType ? 'Day' : 'Start'}</Text>
              <Pressable style={styles.dateBtn} onPress={() => setShowStart(true)}>
                <Text style={styles.dateText}>{startYmd}</Text>
              </Pressable>
            </View>
            {!isBirthdayType && (
              <View style={styles.dateCol}>
                <Text style={styles.label}>End</Text>
                <Pressable
                  style={[styles.dateBtn, singleDay && styles.dateBtnDisabled]}
                  disabled={singleDay}
                  onPress={() => setShowEnd(true)}
                >
                  <Text style={[styles.dateText, singleDay && styles.muted]}>{endYmd}</Text>
                </Pressable>
              </View>
            )}
          </View>

          {!isBirthdayType && (
            <View style={styles.switchRow}>
              <Text style={styles.label}>Half day (0.5)</Text>
              <Switch value={halfDay} onValueChange={setHalfDay} />
            </View>
          )}

          <Text style={styles.label}>Reason (optional)</Text>
          <TextInput
            style={styles.input}
            value={reason}
            onChangeText={setReason}
            placeholder="e.g. medical appointment"
            multiline
          />

          <View style={styles.summary}>
            <Text style={styles.summaryText}>
              This uses <Text style={styles.summaryBold}>{fmtDays(dayCount)}</Text> day
              {dayCount === 1 ? '' : 's'}
              {selectedType?.is_paid && balanceForType
                ? ` · ${fmtDays(balanceForType.remaining_days)} left before this`
                : ''}
            </Text>
            {selectedType?.is_paid &&
              balanceForType &&
              dayCount > balanceForType.remaining_days && (
                <Text style={styles.warn}>Over your remaining balance — HR may still approve.</Text>
              )}
          </View>

          <Pressable
            style={[
              styles.submit,
              (busy || !typeId || dayCount === 0 || birthdayBlocked) && styles.submitDisabled,
            ]}
            disabled={busy || !typeId || dayCount === 0 || birthdayBlocked}
            onPress={submit}
          >
            <Text style={styles.submitText}>{busy ? 'Filing…' : 'File request'}</Text>
          </Pressable>
          {dayCount === 0 && (
            <Text style={styles.muted}>No working days in this range — pick a working day.</Text>
          )}
        </View>

        <Text style={[styles.sectionTitle, { marginTop: 24 }]}>Your requests</Text>
        {requests.length === 0 && <Text style={styles.muted}>No leave requests yet.</Text>}
        {requests.map((r) => (
          <View key={r.id} style={styles.reqRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.reqType}>
                {r.leave_type?.name ?? 'Leave'} · {fmtDays(r.day_count)}d
              </Text>
              <Text style={styles.muted}>
                {r.start_date}
                {r.end_date !== r.start_date ? ` → ${r.end_date}` : ''}
                {r.half_day ? ' · ½ day' : ''}
              </Text>
              {r.review_note ? <Text style={styles.note}>Note: {r.review_note}</Text> : null}
            </View>
            <View style={styles.reqRight}>
              <Text style={[styles.statusText, { color: STATUS_COLOR[r.status] }]}>
                {LEAVE_STATUS_LABELS[r.status]}
              </Text>
              {r.status === 'pending' && (
                <Pressable onPress={() => cancel(r)}>
                  <Text style={styles.cancel}>Cancel</Text>
                </Pressable>
              )}
            </View>
          </View>
        ))}
      </ScrollView>

      {showStart && (
        <DateTimePicker
          value={start}
          mode="date"
          minimumDate={isBirthdayType && birthMonth ? new Date(YEAR, birthMonth - 1, 1) : undefined}
          maximumDate={isBirthdayType && birthMonth ? new Date(YEAR, birthMonth, 0) : undefined}
          onChange={(_e, d) => {
            setShowStart(Platform.OS === 'ios');
            if (d) {
              setStart(d);
              if (d > end) setEnd(d);
            }
          }}
        />
      )}
      {showEnd && (
        <DateTimePicker
          value={end}
          mode="date"
          minimumDate={start}
          onChange={(_e, d) => {
            setShowEnd(Platform.OS === 'ios');
            if (d) setEnd(d);
          }}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#f9fafb' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  back: { fontSize: 16, color: '#B7860B', width: 48 },
  title: { fontSize: 17, fontWeight: '600', color: '#111827' },
  body: { padding: 20, paddingBottom: 48 },
  sectionTitle: { fontSize: 15, fontWeight: '600', color: '#111827', marginBottom: 8 },
  muted: { fontSize: 13, color: '#6b7280', marginTop: 2 },
  balanceRow: { flexDirection: 'row', gap: 10 },
  balanceCard: {
    flex: 1,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 12,
    padding: 12,
    alignItems: 'center',
  },
  balanceName: { fontSize: 12, color: '#6b7280' },
  balanceBig: { fontSize: 24, fontWeight: '700', color: '#111827', marginTop: 2 },
  card: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 14,
    padding: 16,
  },
  label: { fontSize: 13, fontWeight: '500', color: '#374151', marginTop: 10, marginBottom: 6 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  chipActive: { backgroundColor: '#F5C518', borderColor: '#F5C518' },
  chipText: { fontSize: 13, color: '#374151' },
  chipTextActive: { color: '#3A2D06', fontWeight: '700' },
  birthdayHint: { backgroundColor: '#fffbeb', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, marginTop: 4 },
  birthdayHintText: { fontSize: 13, color: '#92400e' },
  dateRow: { flexDirection: 'row', gap: 12 },
  dateCol: { flex: 1 },
  dateBtn: {
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  dateBtnDisabled: { backgroundColor: '#f3f4f6' },
  dateText: { fontSize: 15, color: '#111827' },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 6,
  },
  input: {
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    minHeight: 44,
    color: '#111827',
  },
  summary: { marginTop: 14 },
  summaryText: { fontSize: 14, color: '#374151' },
  summaryBold: { fontWeight: '700', color: '#111827' },
  warn: { fontSize: 13, color: '#b45309', marginTop: 4 },
  submit: {
    marginTop: 16,
    backgroundColor: '#15803d',
    borderRadius: 12,
    paddingVertical: 15,
    alignItems: 'center',
  },
  submitDisabled: { opacity: 0.5 },
  submitText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  reqRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 12,
    padding: 14,
    marginTop: 8,
  },
  reqType: { fontSize: 15, fontWeight: '600', color: '#111827' },
  reqRight: { alignItems: 'flex-end' },
  statusText: { fontSize: 13, fontWeight: '700' },
  cancel: { fontSize: 12, color: '#b91c1c', marginTop: 6 },
  note: { fontSize: 12, color: '#6b7280', marginTop: 4, fontStyle: 'italic' },
});
