import {
  PUNCH_LABELS,
  REVIEWER_ROLES,
  punchWindowForWorkDate,
  type AttendanceStatus,
  type PunchSource,
  type PunchType,
} from '@fermosa/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { PageHeader } from '../components/PageHeader';
import { SelfieThumb } from '../components/SelfieThumb';
import { useAuth } from '../lib/auth';
import { getSelfieUrls } from '../lib/selfieUrls';
import { supabase } from '../lib/supabase';

interface EventRow {
  id: string;
  employee_id: string;
  type: PunchType;
  source: PunchSource;
  happened_at: string;
  received_at: string;
  inside_geofence: boolean | null;
  distance_from_branch_m: number | null;
  selfie_path: string | null;
  employee: { full_name: string; employee_code: string } | null;
  branch: { name: string; shift_start: string; shift_end: string } | null;
}

/** The daily record a punch rolls up into — what actually gets approved. */
interface RecordLite {
  id: string;
  employee_id: string;
  work_date: string;
  status: AttendanceStatus;
  branch: { shift_start: string; shift_end: string } | null;
}

const timeFmt = new Intl.DateTimeFormat('en-PH', {
  timeZone: 'Asia/Manila',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: true,
});

const SOURCE_ICON: Record<PunchSource, string> = { mobile: '📱', web: '💻', kiosk: '🖥️' };

const STATUS_BADGE: Record<AttendanceStatus, string> = {
  pending_review: 'bg-amber-100 text-amber-700',
  approved: 'bg-green-100 text-green-700',
  rejected: 'bg-red-100 text-red-700',
  corrected: 'bg-sky-100 text-sky-700',
};
const STATUS_LABEL: Record<AttendanceStatus, string> = {
  pending_review: 'Pending',
  approved: 'Approved',
  rejected: 'Rejected',
  corrected: 'Corrected',
};

function fenceBadge(e: EventRow) {
  if (e.inside_geofence === null)
    return <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500">No GPS</span>;
  if (e.inside_geofence)
    return <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs text-green-700">In branch</span>;
  return (
    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-700">
      {Math.round(e.distance_from_branch_m ?? 0)} m away
    </span>
  );
}

/**
 * Minutes between the device's stated punch time and the server receive time.
 * Big gaps mean an offline punch that synced late OR a manipulated device
 * clock — either way HR should glance at it (mirrors the engine's
 * `time_mismatch` flag, same 10-minute threshold).
 */
function timeGapMin(e: EventRow): number {
  return Math.round(Math.abs(new Date(e.received_at).getTime() - new Date(e.happened_at).getTime()) / 60_000);
}

const DAY_MS = 86_400_000;

interface EmployeeOption {
  id: string;
  full_name: string;
  employee_code: string;
}

interface BranchOption {
  id: string;
  name: string;
}

export function Punches() {
  const { profile } = useAuth();
  const canReview = profile ? REVIEWER_ROLES.includes(profile.role) : false;

  const [rows, setRows] = useState<EventRow[]>([]);
  const [selfies, setSelfies] = useState<Record<string, string>>({});
  const [records, setRecords] = useState<Record<string, RecordLite>>({}); // eventId → day record
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Filters (RLS already scopes what a branch manager can see; these narrow further).
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [branches, setBranches] = useState<BranchOption[]>([]);
  const [employeeId, setEmployeeId] = useState('');
  const [branchId, setBranchId] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  useEffect(() => {
    supabase
      .from('profiles')
      .select('id, full_name, employee_code')
      .order('full_name')
      .then(({ data }) => setEmployees((data as EmployeeOption[]) ?? []));
    supabase
      .from('branches')
      .select('id, name')
      .eq('is_active', true)
      .order('name')
      .then(({ data }) => setBranches((data as BranchOption[]) ?? []));
  }, []);

  // Discard out-of-order responses when filters change quickly.
  const loadSeq = useRef(0);

  const load = useCallback(() => {
    const seq = ++loadSeq.current;
    const filtered = Boolean(employeeId || branchId || fromDate || toDate);
    let q = supabase
      .from('attendance_events')
      .select(
        'id, employee_id, type, source, happened_at, received_at, inside_geofence, distance_from_branch_m, selfie_path, employee:profiles(full_name, employee_code), branch:branches(name, shift_start, shift_end)',
      )
      .order('happened_at', { ascending: false })
      .limit(filtered ? 100 : 50);
    if (employeeId) q = q.eq('employee_id', employeeId);
    if (branchId) q = q.eq('branch_id', branchId);
    // Manila calendar days → UTC instants.
    if (fromDate) q = q.gte('happened_at', new Date(`${fromDate}T00:00:00+08:00`).toISOString());
    if (toDate) q = q.lt('happened_at', new Date(new Date(`${toDate}T00:00:00+08:00`).getTime() + DAY_MS).toISOString());
    q.then(async ({ data }) => {
        if (seq !== loadSeq.current) return; // a newer load superseded this one
        const list = (data as unknown as EventRow[]) ?? [];
        setRows(list);
        setLoading(false);

        // Selfie thumbnails — cached signed URLs, so auto-refresh doesn't
        // re-download every photo (see lib/selfieUrls.ts).
        const paths = list.filter((r) => r.selfie_path).map((r) => r.selfie_path!);
        if (paths.length > 0) {
          const smap = await getSelfieUrls(paths);
          if (seq !== loadSeq.current) return;
          setSelfies(smap);
        }

        // Map each punch to its daily attendance record (what gets approved).
        const employeeIds = [...new Set(list.map((e) => e.employee_id))];
        if (employeeIds.length === 0) {
          setRecords({});
          return;
        }
        const times = list.map((e) => new Date(e.happened_at).getTime());
        const from = new Date(Math.min(...times) - 2 * DAY_MS).toISOString().slice(0, 10);
        const to = new Date(Math.max(...times) + DAY_MS).toISOString().slice(0, 10);
        const { data: recData } = await supabase
          .from('attendance_records')
          .select('id, employee_id, work_date, status, branch:branches(shift_start, shift_end)')
          .in('employee_id', employeeIds)
          .gte('work_date', from)
          .lte('work_date', to);
        if (seq !== loadSeq.current) return;
        const recs = (recData as unknown as RecordLite[]) ?? [];
        const rmap: Record<string, RecordLite> = {};
        for (const e of list) {
          const t = new Date(e.happened_at).getTime();
          const hit = recs.find((r) => {
            if (r.employee_id !== e.employee_id || !r.branch) return false;
            const w = punchWindowForWorkDate(r.work_date, r.branch.shift_start, r.branch.shift_end);
            return t >= new Date(w.startIso).getTime() && t < new Date(w.endIso).getTime();
          });
          if (hit) rmap[e.id] = hit;
        }
        setRecords(rmap);
      });
  }, [employeeId, branchId, fromDate, toDate]);

  useEffect(() => {
    load();
    const t = setInterval(load, 10_000); // live-ish view while testing devices
    return () => clearInterval(t);
  }, [load]);

  const review = async (recordId: string, status: AttendanceStatus) => {
    setError(null);
    let note: string | null = null;
    if (status === 'rejected') {
      note = window.prompt('Reason for rejection:');
      if (!note?.trim()) return;
    }
    const { error: rpcErr } = await supabase.rpc('review_attendance', {
      p_record_id: recordId,
      p_status: status,
      p_note: note,
      p_corrections: null,
    });
    if (rpcErr) setError(rpcErr.message);
    else load();
  };

  const reviewCell = (e: EventRow) => {
    const rec = records[e.id];
    if (!rec) return <span className="text-xs text-gray-400">—</span>;
    if (rec.status === 'pending_review' && canReview) {
      return (
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => review(rec.id, 'approved')}
            className="rounded-lg bg-green-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-green-700"
          >
            Approve
          </button>
          <button
            onClick={() => review(rec.id, 'rejected')}
            className="rounded-lg bg-red-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-red-700"
          >
            Reject
          </button>
        </div>
      );
    }
    return (
      <span className={`pill ${STATUS_BADGE[rec.status]}`}>{STATUS_LABEL[rec.status]}</span>
    );
  };

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Punches"
        crumb="Punches"
        subtitle="Latest raw clock events (auto-refreshes every 10s). Approving here approves the whole day; use Reviews for corrections."
        right={
          <button onClick={load} className="btn">
            Refresh
          </button>
        }
      />

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      <div className="mt-4 flex flex-wrap items-end gap-3 card p-4">
        <label className="text-sm">
          <span className="block text-xs font-medium text-gray-500">Employee</span>
          <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} className="mt-1 input">
            <option value="">All employees</option>
            {employees.map((e) => (
              <option key={e.id} value={e.id}>
                {e.full_name} ({e.employee_code})
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="block text-xs font-medium text-gray-500">Branch</span>
          <select value={branchId} onChange={(e) => setBranchId(e.target.value)} className="mt-1 input">
            <option value="">All branches</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="block text-xs font-medium text-gray-500">From</span>
          <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="mt-1 input" />
        </label>
        <label className="text-sm">
          <span className="block text-xs font-medium text-gray-500">To</span>
          <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="mt-1 input" />
        </label>
        {(employeeId || branchId || fromDate || toDate) && (
          <button
            onClick={() => {
              setEmployeeId('');
              setBranchId('');
              setFromDate('');
              setToDate('');
            }}
            className="btn text-sm"
          >
            Clear
          </button>
        )}
      </div>

      <div className="card mt-4 overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="bg-ground text-muted">
            <tr>
              <th className="px-4 py-2 font-medium">Selfie</th>
              <th className="px-4 py-2 font-medium">When (Manila)</th>
              <th className="px-4 py-2 font-medium">Employee</th>
              <th className="px-4 py-2 font-medium">Punch</th>
              <th className="px-4 py-2 font-medium">Branch</th>
              <th className="px-4 py-2 font-medium">Geofence</th>
              <th className="px-4 py-2 font-medium">Review</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading && (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-center text-gray-400">Loading…</td>
              </tr>
            )}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-center text-gray-400">
                  No punches yet — clock in from the mobile app.
                </td>
              </tr>
            )}
            {rows.map((e) => (
              <tr key={e.id} className="hover:bg-gray-50">
                <td className="px-4 py-2">
                  {e.selfie_path && selfies[e.selfie_path] ? (
                    <SelfieThumb
                      src={selfies[e.selfie_path]!}
                      alt={`${e.employee?.full_name ?? 'Selfie'} · ${PUNCH_LABELS[e.type]} · ${timeFmt.format(new Date(e.happened_at))}`}
                      className="h-10 w-10 rounded-full object-cover"
                    />
                  ) : e.type === 'clock_in' || e.type === 'clock_out' ? (
                    <span className="text-xs text-amber-600" title="Selfie required but missing">⚠️</span>
                  ) : (
                    <span className="text-xs text-gray-300">—</span>
                  )}
                </td>
                <td className="whitespace-nowrap px-4 py-2 text-gray-900">
                  {timeFmt.format(new Date(e.happened_at))}
                  {timeGapMin(e) > 10 && (
                    <span
                      className="ml-1.5 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700"
                      title="Device time differs from server receive time — offline sync or a changed device clock; check the selfie."
                    >
                      ⏱ {timeGapMin(e)}m gap
                    </span>
                  )}
                </td>
                <td className="px-4 py-2">
                  <span className="font-medium text-gray-900">{e.employee?.full_name ?? '—'}</span>{' '}
                  <span className="text-xs text-gray-500">{e.employee?.employee_code}</span>
                </td>
                <td className="px-4 py-2 text-gray-700">
                  {SOURCE_ICON[e.source]} {PUNCH_LABELS[e.type]}
                </td>
                <td className="px-4 py-2 text-gray-600">{e.branch?.name ?? '—'}</td>
                <td className="px-4 py-2">{fenceBadge(e)}</td>
                <td className="px-4 py-2">{reviewCell(e)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
