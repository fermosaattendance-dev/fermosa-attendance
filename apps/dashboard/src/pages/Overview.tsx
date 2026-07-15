import {
  COMPANY_WIDE_ROLES,
  LIVE_STATUS_LABELS,
  ROLE_LABELS,
  type LiveRosterRow,
  type LiveStatus,
} from '@fermosa/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { supabase } from '../lib/supabase';

const timeFmt = new Intl.DateTimeFormat('en-PH', {
  timeZone: 'Asia/Manila',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: true,
});
const punchTimeFmt = new Intl.DateTimeFormat('en-PH', {
  timeZone: 'Asia/Manila',
  hour: '2-digit',
  minute: '2-digit',
  hour12: true,
});

/** Poll `fn` on an interval and when the tab regains focus/visibility. */
function useAutoRefresh(fn: () => void, ms: number) {
  const saved = useRef(fn);
  saved.current = fn;
  useEffect(() => {
    const tick = () => saved.current();
    const id = setInterval(tick, ms);
    const onVis = () => {
      if (document.visibilityState === 'visible') tick();
    };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('focus', tick);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('focus', tick);
    };
  }, [ms]);
}

const STATUS_BADGE: Record<LiveStatus | 'overdue' | 'leave', string> = {
  working: 'bg-green-100 text-green-700',
  on_break: 'bg-amber-100 text-amber-700',
  clocked_out: 'bg-gray-100 text-gray-500',
  not_in: 'bg-gray-100 text-gray-500',
  overdue: 'bg-red-100 text-red-700',
  leave: 'bg-sky-100 text-sky-700',
};

// Roster sort: attention first.
const SORT_RANK: Record<string, number> = {
  overdue: 0,
  on_break: 1,
  working: 2,
  clocked_out: 4,
  not_in: 5,
  leave: 3,
};

function rowKind(r: LiveRosterRow): keyof typeof STATUS_BADGE {
  if (r.on_leave) return 'leave';
  if (r.overdue) return 'overdue';
  return r.status;
}

function rowLabel(r: LiveRosterRow): string {
  if (r.on_leave) return 'On leave';
  if (r.overdue) return 'Not in yet';
  return LIVE_STATUS_LABELS[r.status];
}

function StatCard({
  label,
  value,
  tone = 'default',
  to,
}: {
  label: string;
  value: number | string;
  tone?: 'default' | 'good' | 'warn' | 'bad' | 'info';
  to?: string;
}) {
  const toneClass = {
    default: 'text-gray-900',
    good: 'text-green-700',
    warn: 'text-amber-700',
    bad: 'text-red-700',
    info: 'text-sky-700',
  }[tone];
  const body = (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <div className={`text-2xl font-bold ${toneClass}`}>{value}</div>
      <div className="mt-0.5 text-xs font-medium text-gray-500">{label}</div>
    </div>
  );
  return to ? (
    <Link to={to} className="block transition hover:shadow-sm">
      {body}
    </Link>
  ) : (
    body
  );
}

export function Overview() {
  const { profile } = useAuth();
  const [roster, setRoster] = useState<LiveRosterRow[]>([]);
  const [pendingReviews, setPendingReviews] = useState<number | null>(null);
  const [pendingLeave, setPendingLeave] = useState<number | null>(null);
  const [asOf, setAsOf] = useState<Date | null>(null);
  const [branchFilter, setBranchFilter] = useState('all');
  const [loading, setLoading] = useState(true);

  const isAdmin = profile ? COMPANY_WIDE_ROLES.includes(profile.role) : false;
  const isManager = profile?.role === 'branch_manager';
  const showBoard = isAdmin || isManager;

  const load = useCallback(() => {
    if (!showBoard) return;
    supabase.rpc('dashboard_live').then(({ data }) => {
      setRoster((data as LiveRosterRow[]) ?? []);
      setAsOf(new Date());
      setLoading(false);
    });
    supabase
      .from('attendance_records')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'pending_review')
      .then(({ count }) => setPendingReviews(count ?? 0));
    supabase
      .from('leave_requests')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'pending')
      .then(({ count }) => setPendingLeave(count ?? 0));
  }, [showBoard]);

  useEffect(load, [load]);
  useAutoRefresh(load, 30_000);

  const branches = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of roster) m.set(r.branch_id, r.branch_name);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [roster]);

  const visible = useMemo(
    () => (branchFilter === 'all' ? roster : roster.filter((r) => r.branch_id === branchFilter)),
    [roster, branchFilter],
  );

  const counts = useMemo(() => {
    const c = { working: 0, on_break: 0, overdue: 0, on_leave: 0, late: 0 };
    for (const r of visible) {
      if (r.on_leave) c.on_leave += 1;
      else if (r.overdue) c.overdue += 1;
      else if (r.status === 'working') c.working += 1;
      else if (r.status === 'on_break') c.on_break += 1;
      if (r.late_minutes > 0) c.late += 1;
    }
    return c;
  }, [visible]);

  const sorted = useMemo(
    () =>
      [...visible].sort((a, b) => {
        const ra = SORT_RANK[rowKind(a)] ?? 9;
        const rb = SORT_RANK[rowKind(b)] ?? 9;
        return ra !== rb ? ra - rb : a.full_name.localeCompare(b.full_name);
      }),
    [visible],
  );

  const perBranch = useMemo(() => {
    const m = new Map<string, { name: string; working: number; notIn: number; onLeave: number }>();
    for (const r of roster) {
      const e = m.get(r.branch_id) ?? { name: r.branch_name, working: 0, notIn: 0, onLeave: 0 };
      if (r.on_leave) e.onLeave += 1;
      else if (r.overdue) e.notIn += 1;
      else if (r.status === 'working' || r.status === 'on_break') e.working += 1;
      m.set(r.branch_id, e);
    }
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [roster]);

  if (!profile) return null;

  if (!showBoard) {
    return (
      <div className="mx-auto max-w-2xl">
        <h2 className="text-lg font-semibold text-gray-900">
          Welcome, {profile.full_name.split(' ')[0]}
        </h2>
        <p className="text-sm text-gray-500">
          {ROLE_LABELS[profile.role]} · {profile.employee_code}
        </p>
        <div className="mt-6 rounded-xl border border-gray-200 bg-white p-6 text-sm text-gray-600">
          Clock in and out, and file leave, from the Fermosa Attendance mobile app. This dashboard is
          for managers and HR.
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl">
      <div className="flex items-end justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Today</h2>
          <p className="text-sm text-gray-500">
            {isAdmin ? 'Company-wide' : 'Your branch'} · live status
          </p>
        </div>
        <div className="flex items-center gap-3 text-xs text-gray-400">
          {asOf && <span>as of {timeFmt.format(asOf)}</span>}
          <button
            onClick={load}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
          >
            Refresh
          </button>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
        <StatCard label="Working" value={counts.working} tone="good" />
        <StatCard label="On break" value={counts.on_break} tone="warn" />
        <StatCard label="Not in yet" value={counts.overdue} tone="bad" />
        <StatCard label="Late today" value={counts.late} tone="warn" />
        <StatCard label="On leave" value={counts.on_leave} tone="info" />
        <StatCard
          label="Pending reviews"
          value={pendingReviews ?? '…'}
          tone={pendingReviews ? 'warn' : 'default'}
          to="/reviews"
        />
        <StatCard
          label="Pending leave"
          value={pendingLeave ?? '…'}
          tone={pendingLeave ? 'warn' : 'default'}
          to="/leave"
        />
      </div>

      {isAdmin && perBranch.length > 1 && (
        <>
          <h3 className="mt-8 text-base font-semibold text-gray-900">By branch</h3>
          <div className="mt-3 overflow-hidden rounded-xl border border-gray-200 bg-white">
            <table className="w-full text-left text-sm">
              <thead className="bg-gray-50 text-gray-600">
                <tr>
                  <th className="px-4 py-2 font-medium">Branch</th>
                  <th className="px-4 py-2 font-medium">In / on break</th>
                  <th className="px-4 py-2 font-medium">Not in yet</th>
                  <th className="px-4 py-2 font-medium">On leave</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {perBranch.map((b) => (
                  <tr key={b.name} className="hover:bg-gray-50">
                    <td className="px-4 py-2 font-medium text-gray-900">{b.name}</td>
                    <td className="px-4 py-2 text-gray-700">{b.working}</td>
                    <td className={`px-4 py-2 ${b.notIn ? 'font-medium text-red-600' : 'text-gray-400'}`}>
                      {b.notIn}
                    </td>
                    <td className="px-4 py-2 text-gray-700">{b.onLeave}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <div className="mt-8 flex items-center justify-between">
        <h3 className="text-base font-semibold text-gray-900">Roster</h3>
        {branches.length > 1 && (
          <select
            value={branchFilter}
            onChange={(e) => setBranchFilter(e.target.value)}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm"
          >
            <option value="all">All branches</option>
            {branches.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="mt-3 overflow-hidden rounded-xl border border-gray-200 bg-white">
        <table className="w-full text-left text-sm">
          <thead className="bg-gray-50 text-gray-600">
            <tr>
              <th className="px-4 py-2 font-medium">Employee</th>
              {branches.length > 1 && <th className="px-4 py-2 font-medium">Branch</th>}
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 font-medium">Late</th>
              <th className="px-4 py-2 font-medium">Last punch</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-gray-400">
                  Loading…
                </td>
              </tr>
            )}
            {!loading && sorted.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-gray-400">
                  No active employees to show.
                </td>
              </tr>
            )}
            {sorted.map((r) => (
              <tr key={r.employee_id} className="hover:bg-gray-50">
                <td className="px-4 py-2">
                  <div className="font-medium text-gray-900">{r.full_name}</div>
                  <div className="text-xs text-gray-500">{r.employee_code}</div>
                </td>
                {branches.length > 1 && <td className="px-4 py-2 text-gray-600">{r.branch_name}</td>}
                <td className="px-4 py-2">
                  <span className={`rounded-full px-2 py-0.5 text-xs ${STATUS_BADGE[rowKind(r)]}`}>
                    {rowLabel(r)}
                  </span>
                  {!r.scheduled && !r.on_leave && (
                    <span className="ml-1.5 text-[11px] text-gray-400">rest day</span>
                  )}
                </td>
                <td className="px-4 py-2 text-gray-700">
                  {r.late_minutes > 0 ? `${r.late_minutes}m` : '—'}
                </td>
                <td className="px-4 py-2 text-gray-500">
                  {r.last_punch_at ? punchTimeFmt.format(new Date(r.last_punch_at)) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
