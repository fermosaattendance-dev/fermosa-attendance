import {
  COMPANY_WIDE_ROLES,
  LIVE_STATUS_LABELS,
  ROLE_LABELS,
  type LiveRosterRow,
  type LiveStatus,
} from '@fermosa/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
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
    <div className={`card p-4 ${to ? 'relative transition hover:border-brand-400 hover:shadow-md' : ''}`}>
      <div className={`tnum text-2xl font-bold ${toneClass}`}>{value}</div>
      <div className="mt-1 text-xs font-semibold text-muted">{label}</div>
      {to && <span className="absolute right-3 top-3 font-bold text-brand-600">→</span>}
    </div>
  );
  return to ? (
    <Link to={to} className="block">
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
    // Null branch = roving employee who hasn't punched at a branch yet today.
    for (const r of roster) if (r.branch_id && r.branch_name) m.set(r.branch_id, r.branch_name);
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
      if (!r.branch_id || !r.branch_name) continue; // roving, not at a branch yet
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
        <PageHeader
          title={`Welcome, ${profile.full_name.split(' ')[0]}`}
          subtitle={`${ROLE_LABELS[profile.role]} · ${profile.employee_code}`}
        />
        <div className="card p-6 text-sm text-muted">
          Time in and out, and file leave, from the Fermosa Attendance mobile app. This dashboard is
          for managers and HR.
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Today"
        crumb="Dashboard"
        subtitle={`${isAdmin ? 'Company-wide' : 'Your branch'} · live status`}
        right={
          <>
            {asOf && <span className="tnum text-xs text-muted">as of {timeFmt.format(asOf)}</span>}
            <button onClick={load} className="btn">
              Refresh
            </button>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
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
          <h3 className="mt-8 mb-3 text-base font-semibold text-ink">By branch</h3>
          <div className="card overflow-x-auto">
            <table className="fm-table">
              <thead>
                <tr>
                  <th>Branch</th>
                  <th>In / on break</th>
                  <th>Not in yet</th>
                  <th>On leave</th>
                </tr>
              </thead>
              <tbody>
                {perBranch.map((b) => (
                  <tr key={b.name}>
                    <td className="font-semibold text-ink">{b.name}</td>
                    <td className="tnum text-ink/80">{b.working}</td>
                    <td className={`tnum ${b.notIn ? 'font-semibold text-red-600' : 'text-muted'}`}>
                      {b.notIn}
                    </td>
                    <td className="tnum text-ink/80">{b.onLeave}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <div className="mt-8 mb-3 flex items-center justify-between gap-3">
        <h3 className="text-base font-semibold text-ink">Roster</h3>
        {branches.length > 1 && (
          <select
            value={branchFilter}
            onChange={(e) => setBranchFilter(e.target.value)}
            className="input max-w-[220px]"
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

      <div className="card overflow-x-auto">
        <table className="fm-table">
          <thead>
            <tr>
              <th>Employee</th>
              {branches.length > 1 && <th>Branch</th>}
              <th>Status</th>
              <th>Late</th>
              <th>Last punch</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={5} className="text-center text-muted">
                  Loading…
                </td>
              </tr>
            )}
            {!loading && sorted.length === 0 && (
              <tr>
                <td colSpan={5} className="text-center text-muted">
                  No active employees to show.
                </td>
              </tr>
            )}
            {sorted.map((r) => (
              <tr key={r.employee_id}>
                <td>
                  <div className="font-semibold text-ink">{r.full_name}</div>
                  <div className="text-xs text-muted">{r.employee_code}</div>
                </td>
                {branches.length > 1 && <td className="text-muted">{r.branch_name ?? '—'}</td>}
                <td>
                  <span className={`pill ${STATUS_BADGE[rowKind(r)]}`}>{rowLabel(r)}</span>
                  {r.branch_id && !r.scheduled && !r.on_leave && (
                    <span className="ml-1.5 text-[11px] text-muted">rest day</span>
                  )}
                </td>
                <td className="tnum text-ink/80">
                  {r.late_minutes > 0 ? `${r.late_minutes}m` : '—'}
                </td>
                <td className="tnum text-muted">
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
