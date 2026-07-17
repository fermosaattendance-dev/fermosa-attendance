import { LEAVE_STATUS_LABELS, REVIEWER_ROLES, type LeaveStatus } from '@fermosa/shared';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useAuth } from '../lib/auth';
import { supabase } from '../lib/supabase';

interface RequestRow {
  id: string;
  employee_id: string;
  leave_type_id: string;
  start_date: string;
  end_date: string;
  half_day: boolean;
  day_count: number;
  reason: string | null;
  status: LeaveStatus;
  review_note: string | null;
  reviewed_at: string | null;
  employee: { id: string; full_name: string; employee_code: string } | null;
  leave_type: { id: string; name: string; is_paid: boolean } | null;
}

interface BalanceRow {
  id: string;
  employee_id: string;
  leave_type_id: string;
  year: number;
  entitled_days: number;
  used_days: number;
  remaining_days: number;
}

interface EmployeeLite {
  id: string;
  full_name: string;
  employee_code: string;
  branch_id: string | null;
  birthday: string | null;
}

interface TypeLite {
  id: string;
  name: string;
  is_paid: boolean;
  is_active: boolean;
  birthday_only: boolean;
}

const STATUS_BADGE: Record<LeaveStatus, string> = {
  pending: 'bg-amber-100 text-amber-700',
  approved: 'bg-green-100 text-green-700',
  rejected: 'bg-red-100 text-red-700',
  cancelled: 'bg-gray-100 text-gray-500',
};

const inputClass =
  'mt-1 input';
const labelClass = 'block text-sm font-medium text-gray-700';
const YEAR = new Date().getFullYear();

const fmtDays = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

export function Leave() {
  const { profile } = useAuth();
  const canApprove = profile ? REVIEWER_ROLES.includes(profile.role) : false;

  const [tab, setTab] = useState<'requests' | 'balances'>('requests');
  const [statusFilter, setStatusFilter] = useState<string>('pending');
  const [requests, setRequests] = useState<RequestRow[]>([]);
  const [balances, setBalances] = useState<BalanceRow[]>([]);
  const [employees, setEmployees] = useState<EmployeeLite[]>([]);
  const [types, setTypes] = useState<TypeLite[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Balance lookup for the requests list: "remaining" for an employee+type.
  const remainingFor = useMemo(() => {
    const m = new Map<string, number>();
    for (const b of balances) m.set(`${b.employee_id}:${b.leave_type_id}`, b.remaining_days);
    return m;
  }, [balances]);

  const loadRequests = useCallback(() => {
    let q = supabase
      .from('leave_requests')
      .select(
        'id, employee_id, leave_type_id, start_date, end_date, half_day, day_count, reason, status, review_note, reviewed_at, employee:profiles!leave_requests_employee_id_fkey(id, full_name, employee_code), leave_type:leave_types(id, name, is_paid)',
      )
      .order('start_date', { ascending: false })
      .limit(200);
    if (statusFilter !== 'all') q = q.eq('status', statusFilter);
    q.then(({ data }) => setRequests((data as unknown as RequestRow[]) ?? []));
  }, [statusFilter]);

  const loadBalances = useCallback(() => {
    supabase
      .from('leave_balances_view')
      .select('id, employee_id, leave_type_id, year, entitled_days, used_days, remaining_days')
      .eq('year', YEAR)
      .then(({ data }) => setBalances((data as BalanceRow[]) ?? []));
  }, []);

  useEffect(() => {
    loadRequests();
    loadBalances();
    supabase
      .from('profiles')
      .select('id, full_name, employee_code, branch_id, birthday')
      .order('full_name')
      .then(({ data }) => setEmployees((data as EmployeeLite[]) ?? []));
    supabase
      .from('leave_types')
      .select('id, name, is_paid, is_active, birthday_only')
      .order('name')
      .then(({ data }) => setTypes((data as TypeLite[]) ?? []));
  }, [loadRequests, loadBalances]);

  const review = async (id: string, status: 'approved' | 'rejected') => {
    setError(null);
    let note: string | null = null;
    if (status === 'rejected') {
      note = window.prompt('Reason for rejection:');
      if (!note?.trim()) return;
    }
    const { error: err } = await supabase.rpc('review_leave', {
      p_request_id: id,
      p_status: status,
      p_note: note,
    });
    if (err) setError(err.message);
    else {
      loadRequests();
      loadBalances();
    }
  };

  const nameOf = (id: string) => employees.find((e) => e.id === id)?.full_name ?? '—';
  const typeNameOf = (id: string) => types.find((t) => t.id === id)?.name ?? '—';

  return (
    <div className="mx-auto max-w-5xl">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-ink">Leave</h2>
          <p className="text-sm text-gray-500">
            Requests and balances. {canApprove ? 'Approve or reject below.' : 'View only.'}
          </p>
        </div>
        <div className="flex gap-1 rounded-lg border border-gray-200 bg-white p-1 text-sm">
          <button
            onClick={() => setTab('requests')}
            className={`rounded-md px-3 py-1.5 ${tab === 'requests' ? 'bg-brand-500 text-on-gold' : 'text-gray-600'}`}
          >
            Requests
          </button>
          {canApprove && (
            <button
              onClick={() => setTab('balances')}
              className={`rounded-md px-3 py-1.5 ${tab === 'balances' ? 'bg-brand-500 text-on-gold' : 'text-gray-600'}`}
            >
              Balances
            </button>
          )}
        </div>
      </div>

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
      {notice && <p className="mt-3 text-sm text-green-700">{notice}</p>}

      {tab === 'requests' ? (
        <>
          {canApprove && (
            <FileForEmployee
              employees={employees}
              types={types.filter((t) => t.is_active)}
              onFiled={() => {
                setNotice('Leave filed as pending. It now appears in the queue for approval.');
                loadRequests();
              }}
              onError={setError}
            />
          )}

          <div className="mt-4 flex gap-2">
            {['pending', 'approved', 'rejected', 'cancelled', 'all'].map((s) => (
              <button
                key={s}
                onClick={() => setStatusFilter(s)}
                className={`rounded-lg px-3 py-1.5 text-sm ${
                  statusFilter === s ? 'bg-brand-500 text-on-gold' : 'border border-gray-300 text-gray-600 hover:bg-gray-100'
                }`}
              >
                {s === 'all' ? 'All' : LEAVE_STATUS_LABELS[s as LeaveStatus]}
              </button>
            ))}
          </div>

          <div className="mt-3 overflow-hidden card">
            <table className="w-full text-left text-sm">
              <thead className="bg-ground text-muted">
                <tr>
                  <th className="px-4 py-2 font-medium">Employee</th>
                  <th className="px-4 py-2 font-medium">Type</th>
                  <th className="px-4 py-2 font-medium">Dates</th>
                  <th className="px-4 py-2 font-medium">Days</th>
                  <th className="px-4 py-2 font-medium">Reason</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {requests.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-6 text-center text-gray-400">
                      No leave requests.
                    </td>
                  </tr>
                )}
                {requests.map((r) => {
                  const remaining = r.leave_type?.is_paid
                    ? remainingFor.get(`${r.employee_id}:${r.leave_type_id}`)
                    : undefined;
                  return (
                    <tr key={r.id} className="align-top hover:bg-gray-50">
                      <td className="px-4 py-2">
                        <div className="font-medium text-gray-900">
                          {r.employee?.full_name ?? nameOf(r.employee_id)}
                        </div>
                        <div className="text-xs text-gray-500">{r.employee?.employee_code}</div>
                      </td>
                      <td className="px-4 py-2 text-gray-700">
                        {r.leave_type?.name ?? typeNameOf(r.leave_type_id)}
                        {r.leave_type && !r.leave_type.is_paid && (
                          <span className="ml-1 rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500">
                            Unpaid
                          </span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2 text-gray-700">
                        {r.start_date}
                        {r.end_date !== r.start_date && ` → ${r.end_date}`}
                        {r.half_day && <span className="ml-1 text-xs text-indigo-600">½ day</span>}
                      </td>
                      <td className="px-4 py-2 text-gray-900">
                        {fmtDays(r.day_count)}
                        {remaining !== undefined && (
                          <div className="text-[11px] text-gray-400">{fmtDays(remaining)} left</div>
                        )}
                      </td>
                      <td className="max-w-xs px-4 py-2 text-gray-600">
                        {r.reason || <span className="text-gray-300">—</span>}
                        {r.review_note && (
                          <div className="mt-0.5 text-xs italic text-gray-400">Note: {r.review_note}</div>
                        )}
                      </td>
                      <td className="px-4 py-2">
                        <span className={`rounded-full px-2 py-0.5 text-xs ${STATUS_BADGE[r.status]}`}>
                          {LEAVE_STATUS_LABELS[r.status]}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-right">
                        {canApprove && r.status === 'pending' && (
                          <div className="flex justify-end gap-2">
                            <button
                              onClick={() => review(r.id, 'approved')}
                              className="rounded-lg bg-green-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-green-700"
                            >
                              Approve
                            </button>
                            <button
                              onClick={() => review(r.id, 'rejected')}
                              className="btn px-2.5 py-1 text-xs"
                            >
                              Reject
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <BalancesTab
          balances={balances}
          employees={employees}
          types={types}
          onSaved={() => {
            setNotice('Entitlement updated.');
            loadBalances();
          }}
          onError={setError}
        />
      )}
    </div>
  );
}

function FileForEmployee({
  employees,
  types,
  onFiled,
  onError,
}: {
  employees: EmployeeLite[];
  types: TypeLite[];
  onFiled: () => void;
  onError: (m: string) => void;
}) {
  const { profile } = useAuth();
  const [open, setOpen] = useState(false);
  const [employeeId, setEmployeeId] = useState('');
  const [typeId, setTypeId] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [halfDay, setHalfDay] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const selectedEmp = employees.find((e) => e.id === employeeId) ?? null;
  const selectedType = types.find((t) => t.id === typeId) ?? null;
  const isBirthdayType = selectedType?.birthday_only ?? false;
  const birthMonth = selectedEmp?.birthday ? Number(selectedEmp.birthday.slice(5, 7)) : null; // 1–12
  const birthMonthName = birthMonth
    ? new Date(2000, birthMonth - 1, 1).toLocaleString('en-US', { month: 'long' })
    : '';
  const yr = new Date().getFullYear();
  const bmm = birthMonth ? String(birthMonth).padStart(2, '0') : '01';
  const birthMonthMin = `${yr}-${bmm}-01`;
  const birthMonthMax = birthMonth
    ? `${yr}-${bmm}-${String(new Date(yr, birthMonth, 0).getDate()).padStart(2, '0')}`
    : `${yr}-01-31`;
  const startInBirthMonth = !!birthMonth && start.slice(5, 7) === bmm;
  const birthdayBlocked = isBirthdayType && (!selectedEmp?.birthday || !startInBirthMonth);

  // For Birthday Leave, snap the date into the selected employee's birth month.
  useEffect(() => {
    if (!isBirthdayType || !birthMonth) return;
    setHalfDay(false);
    if (start.slice(5, 7) !== bmm) setStart(birthMonthMin);
  }, [isBirthdayType, birthMonth, bmm, start, birthMonthMin]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!employeeId || !typeId || !start) return;
    if (isBirthdayType && !selectedEmp?.birthday) {
      onError('This employee has no birthday on file — add it on their profile first.');
      return;
    }
    if (isBirthdayType && !startInBirthMonth) {
      onError(`Birthday leave can only be taken in the employee's birth month (${birthMonthName}).`);
      return;
    }
    setBusy(true);
    const endDate = halfDay || isBirthdayType ? start : end || start;
    const { error: err } = await supabase.from('leave_requests').insert({
      company_id: profile!.company_id,
      employee_id: employeeId,
      leave_type_id: typeId,
      start_date: start,
      end_date: endDate,
      half_day: halfDay,
      reason: reason.trim() || null,
      status: 'pending',
    });
    setBusy(false);
    if (err) {
      onError(err.message);
      return;
    }
    setEmployeeId('');
    setTypeId('');
    setStart('');
    setEnd('');
    setHalfDay(false);
    setReason('');
    setOpen(false);
    onFiled();
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="mt-4 btn-primary"
      >
        File leave for an employee
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="mt-4 card p-6">
      <h3 className="text-sm font-semibold text-gray-900">File leave on behalf of an employee</h3>
      <div className="mt-3 grid grid-cols-2 gap-4">
        <div>
          <label className={labelClass}>Employee</label>
          <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} className={inputClass} required>
            <option value="">Select…</option>
            {employees.map((e) => (
              <option key={e.id} value={e.id}>
                {e.full_name} ({e.employee_code})
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelClass}>Leave type</label>
          <select value={typeId} onChange={(e) => setTypeId(e.target.value)} className={inputClass} required>
            <option value="">Select…</option>
            {types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
                {t.is_paid ? '' : ' (unpaid)'}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelClass}>{isBirthdayType ? 'Day' : 'Start date'}</label>
          <input
            type="date"
            value={start}
            min={isBirthdayType ? birthMonthMin : undefined}
            max={isBirthdayType ? birthMonthMax : undefined}
            onChange={(e) => setStart(e.target.value)}
            className={inputClass}
            required
          />
        </div>
        {!isBirthdayType && (
          <div>
            <label className={labelClass}>End date</label>
            <input
              type="date"
              value={halfDay ? start : end}
              min={start}
              disabled={halfDay}
              onChange={(e) => setEnd(e.target.value)}
              className={`${inputClass} disabled:bg-gray-100`}
            />
          </div>
        )}
      </div>
      {isBirthdayType && (
        <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {selectedEmp?.birthday
            ? `🎂 Birthday leave — one paid day, any day in ${selectedEmp.full_name.split(' ')[0]}'s birth month (${birthMonthName}).`
            : '🎂 Birthday leave — this employee has no birthday on file. Add it on their profile first.'}
        </p>
      )}
      {!isBirthdayType && (
        <label className="mt-3 flex items-center gap-2 text-sm text-gray-700">
          <input type="checkbox" checked={halfDay} onChange={(e) => setHalfDay(e.target.checked)} />
          Half day (single day, counts 0.5)
        </label>
      )}
      <div className="mt-3">
        <label className={labelClass}>Reason</label>
        <input value={reason} onChange={(e) => setReason(e.target.value)} className={inputClass} placeholder="optional" />
      </div>
      <div className="mt-4 flex gap-2">
        <button
          type="submit"
          disabled={busy || birthdayBlocked}
          className="btn-primary disabled:opacity-50"
        >
          {busy ? 'Filing…' : 'File (pending)'}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="btn"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function BalancesTab({
  balances,
  employees,
  types,
  onSaved,
  onError,
}: {
  balances: BalanceRow[];
  employees: EmployeeLite[];
  types: TypeLite[];
  onSaved: () => void;
  onError: (m: string) => void;
}) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [search, setSearch] = useState('');
  const [mode, setMode] = useState<'all' | 'used' | 'left' | 'noleft'>('all');

  // One column per leave type that has balance rows, ordered: main paid pool →
  // birthday → unpaid — so the table stays one row per employee.
  const cols = useMemo(() => {
    const withRows = new Set(balances.map((b) => b.leave_type_id));
    const rank = (t: TypeLite) => (!t.is_paid ? 2 : t.birthday_only ? 1 : 0);
    return types
      .filter((t) => withRows.has(t.id))
      .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  }, [balances, types]);

  interface EmpRow {
    employeeId: string;
    name: string;
    code: string;
    byType: Record<string, BalanceRow>;
    totalUsed: number;
    paidRemaining: number;
  }

  const rows: EmpRow[] = useMemo(() => {
    const paidIds = new Set(types.filter((t) => t.is_paid).map((t) => t.id));
    const byEmp = new Map<string, EmpRow>();
    for (const b of balances) {
      let r = byEmp.get(b.employee_id);
      if (!r) {
        const emp = employees.find((e) => e.id === b.employee_id);
        r = {
          employeeId: b.employee_id,
          name: emp?.full_name ?? '—',
          code: emp?.employee_code ?? '',
          byType: {},
          totalUsed: 0,
          paidRemaining: 0,
        };
        byEmp.set(b.employee_id, r);
      }
      r.byType[b.leave_type_id] = b;
      r.totalUsed += b.used_days;
      if (paidIds.has(b.leave_type_id)) r.paidRemaining += b.remaining_days;
    }
    return [...byEmp.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [balances, employees, types]);

  const q = search.trim().toLowerCase();
  const visible = rows.filter((r) => {
    if (q && !r.name.toLowerCase().includes(q) && !r.code.toLowerCase().includes(q)) return false;
    if (mode === 'used') return r.totalUsed > 0;
    if (mode === 'left') return r.paidRemaining > 0;
    if (mode === 'noleft') return r.paidRemaining <= 0;
    return true;
  });

  /** Save every edited entitlement on this employee's row. */
  const saveRow = async (r: EmpRow) => {
    const dirtyIds = Object.values(r.byType)
      .map((b) => b.id)
      .filter((id) => draft[id] !== undefined);
    for (const id of dirtyIds) {
      const value = Number(draft[id]);
      if (Number.isNaN(value) || value < 0) {
        onError('Entitlement must be a non-negative number.');
        return;
      }
    }
    for (const id of dirtyIds) {
      const { error: err } = await supabase
        .from('leave_balances')
        .update({ entitled_days: Number(draft[id]) })
        .eq('id', id);
      if (err) {
        onError(err.message);
        return;
      }
    }
    setDraft((d) => {
      const next = { ...d };
      for (const id of dirtyIds) delete next[id];
      return next;
    });
    onSaved();
  };

  return (
    <div className="mt-4 overflow-hidden card">
      <div className="border-b border-gray-100 px-4 py-2 text-xs text-gray-500">
        {YEAR} entitlements — one row per employee. Used and remaining are computed from approved
        requests. Edit an entitlement and press Save. Use “Grant entitlements” on the Settings page
        to create rows for everyone.
      </div>
      <div className="flex flex-wrap items-center gap-2 border-b border-gray-100 px-4 py-3">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name or code…"
          className="input w-56"
        />
        <select
          value={mode}
          onChange={(e) => setMode(e.target.value as typeof mode)}
          className="input w-auto"
        >
          <option value="all">All employees</option>
          <option value="used">Has used leave</option>
          <option value="left">Has remaining leave</option>
          <option value="noleft">No remaining leave</option>
        </select>
        <span className="ml-auto text-xs text-gray-500">
          {visible.length} of {rows.length} employee{rows.length === 1 ? '' : 's'}
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="bg-ground text-muted">
            <tr>
              <th className="px-4 py-2 font-medium">Employee</th>
              {cols.map((t) => (
                <th key={t.id} className="px-4 py-2 font-medium">
                  {t.name}
                  {t.is_paid ? '' : ' (unpaid)'}
                </th>
              ))}
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {visible.length === 0 && (
              <tr>
                <td colSpan={cols.length + 2} className="px-4 py-6 text-center text-gray-400">
                  {rows.length === 0
                    ? 'No balances yet. Grant entitlements from the Settings page.'
                    : 'No employees match the filter.'}
                </td>
              </tr>
            )}
            {visible.map((r) => {
              const dirty = Object.values(r.byType).some((b) => draft[b.id] !== undefined);
              return (
                <tr key={r.employeeId} className="hover:bg-gray-50 align-top">
                  <td className="px-4 py-2">
                    <div className="font-medium text-gray-900">{r.name}</div>
                    {r.code && <div className="text-xs text-gray-400">{r.code}</div>}
                  </td>
                  {cols.map((t) => {
                    const b = r.byType[t.id];
                    return (
                      <td key={t.id} className="px-4 py-2">
                        {b ? (
                          <div>
                            <input
                              value={draft[b.id] ?? fmtDays(b.entitled_days)}
                              onChange={(e) => setDraft((d) => ({ ...d, [b.id]: e.target.value }))}
                              className="w-16 input"
                            />
                            <div className="mt-1 text-xs text-gray-500">
                              used {fmtDays(b.used_days)} ·{' '}
                              <span
                                className={
                                  // Warning red when the pool is running low (≤ 2 left on a
                                  // pool bigger than 2 — small pools like Birthday/Unpaid sit
                                  // at 1/0 by design) or overdrawn.
                                  b.remaining_days < 0 ||
                                  (b.entitled_days > 2 && b.remaining_days <= 2)
                                    ? 'font-semibold text-red-600'
                                    : 'font-medium text-gray-900'
                                }
                              >
                                left {fmtDays(b.remaining_days)}
                              </span>
                            </div>
                          </div>
                        ) : (
                          <span className="text-gray-300">—</span>
                        )}
                      </td>
                    );
                  })}
                  <td className="px-4 py-2 text-right">
                    {dirty && (
                      <button onClick={() => saveRow(r)} className="btn-primary px-2.5 py-1 text-xs">
                        Save
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
