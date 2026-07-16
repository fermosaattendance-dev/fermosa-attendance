import {
  PUNCH_LABELS,
  REVIEWER_ROLES,
  punchWindowForWorkDate,
  type AttendanceStatus,
  type PunchSource,
  type PunchType,
} from '@fermosa/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { SelfieThumb } from '../components/SelfieThumb';
import { useAuth } from '../lib/auth';
import { getSelfieUrls } from '../lib/selfieUrls';
import { supabase } from '../lib/supabase';

interface RecordRow {
  id: string;
  work_date: string;
  status: AttendanceStatus;
  review_note: string | null;
  reviewed_at: string | null;
  worked_minutes: number | null;
  break_minutes: number | null;
  late_minutes: number | null;
  undertime_minutes: number | null;
  overtime_minutes: number | null;
  day_class: string | null;
  flags: string[];
  corrections: Record<string, number> | null;
  employee: { id: string; full_name: string; employee_code: string } | null;
  branch: { name: string; shift_start: string; shift_end: string } | null;
  reviewer: { full_name: string } | null;
}

const FLAG_BADGE: Record<string, string> = {
  on_time: 'bg-green-100 text-green-700',
  late: 'bg-amber-100 text-amber-700',
  early_out: 'bg-amber-100 text-amber-700',
  overtime: 'bg-sky-100 text-sky-700',
  no_clock_out: 'bg-red-100 text-red-700',
  absent: 'bg-red-100 text-red-700',
  on_leave: 'bg-green-100 text-green-700',
  half_day: 'bg-orange-100 text-orange-700', // 1+ hr late — payroll counts 0.5 day
  time_mismatch: 'bg-red-100 text-red-700', // device clock vs server clock gap
};

const DAY_CLASS_LABEL: Record<string, string> = {
  regular: '',
  rest_day: 'Rest day',
  regular_holiday: 'Holiday',
  special_holiday: 'Special holiday',
};

function fmtMinutes(m: number | null | undefined): string {
  if (m === null || m === undefined) return '—';
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** Corrections layer over computed values. */
function effective(r: RecordRow, key: 'worked_minutes' | 'late_minutes' | 'overtime_minutes'): number | null {
  return r.corrections?.[key] ?? r[key];
}

interface EventRow {
  id: string;
  type: PunchType;
  source: PunchSource;
  happened_at: string;
  received_at: string;
  inside_geofence: boolean | null;
  distance_from_branch_m: number | null;
  selfie_path: string | null;
}

const STATUS_BADGE: Record<AttendanceStatus, string> = {
  pending_review: 'bg-amber-100 text-amber-700',
  approved: 'bg-green-100 text-green-700',
  rejected: 'bg-red-100 text-red-700',
  corrected: 'bg-sky-100 text-sky-700',
};

const STATUS_LABEL: Record<AttendanceStatus, string> = {
  pending_review: 'Pending review',
  approved: 'Approved',
  rejected: 'Rejected',
  corrected: 'Corrected',
};

const timeFmt = new Intl.DateTimeFormat('en-PH', {
  timeZone: 'Asia/Manila',
  hour: '2-digit',
  minute: '2-digit',
  hour12: true,
});

// Manila calendar date of a timestamp, for the "+1" hint on overnight punches.
const manilaDateFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Manila',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function DayDetail({ record }: { record: RecordRow }) {
  const [events, setEvents] = useState<EventRow[]>([]);
  const [selfies, setSelfies] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!record.employee) return;
    // The branch's work-day window in UTC (follows the shift cutoff, so
    // overnight shifts include their post-midnight punches).
    const { startIso: start, endIso: end } = record.branch
      ? punchWindowForWorkDate(record.work_date, record.branch.shift_start, record.branch.shift_end)
      : {
          startIso: new Date(`${record.work_date}T00:00:00+08:00`).toISOString(),
          endIso: new Date(new Date(`${record.work_date}T00:00:00+08:00`).getTime() + 24 * 3600 * 1000).toISOString(),
        };
    supabase
      .from('attendance_events')
      .select('id, type, source, happened_at, received_at, inside_geofence, distance_from_branch_m, selfie_path')
      .eq('employee_id', record.employee.id)
      .gte('happened_at', start)
      .lt('happened_at', end)
      .order('happened_at')
      .then(async ({ data }) => {
        const rows = (data as EventRow[]) ?? [];
        setEvents(rows);
        const paths = rows.filter((r) => r.selfie_path).map((r) => r.selfie_path!);
        if (paths.length > 0) {
          setSelfies(await getSelfieUrls(paths));
        }
      });
  }, [record]);

  if (events.length === 0) {
    return <p className="px-4 py-3 text-sm text-gray-400">No punches loaded for this day.</p>;
  }

  return (
    <div className="flex flex-wrap gap-3 bg-gray-50 px-4 py-3">
      {events.map((e) => (
        <div key={e.id} className="w-40 rounded-lg border border-gray-200 bg-white p-2">
          {e.selfie_path && selfies[e.selfie_path] ? (
            <SelfieThumb
              src={selfies[e.selfie_path]!}
              alt={`Selfie · ${PUNCH_LABELS[e.type]} · ${timeFmt.format(new Date(e.happened_at))}`}
              className="h-32 w-full rounded object-cover"
              frameClassName="w-full rounded"
            />
          ) : (
            <div className="flex h-32 w-full items-center justify-center rounded bg-gray-100 text-xs text-gray-400">
              {e.type === 'clock_in' || e.type === 'clock_out' ? 'No selfie ⚠️' : 'No selfie needed'}
            </div>
          )}
          <p className="mt-2 text-xs font-semibold text-gray-900">{PUNCH_LABELS[e.type]}</p>
          <p className="text-xs text-gray-500">
            {timeFmt.format(new Date(e.happened_at))}
            {manilaDateFmt.format(new Date(e.happened_at)) !== record.work_date && (
              <span className="font-semibold text-indigo-600"> +1</span>
            )}
            {' · '}{e.source}
          </p>
          <p className="text-xs">
            {e.inside_geofence === null ? (
              <span className="text-gray-400">No GPS</span>
            ) : e.inside_geofence ? (
              <span className="text-green-700">In branch</span>
            ) : (
              <span className="text-amber-700">{Math.round(e.distance_from_branch_m ?? 0)} m away</span>
            )}
          </p>
        </div>
      ))}
    </div>
  );
}

function CorrectionForm({
  record,
  onSave,
  onCancel,
}: {
  record: RecordRow;
  onSave: (note: string, corrections: Record<string, number>) => void;
  onCancel: () => void;
}) {
  const [worked, setWorked] = useState(String(effective(record, 'worked_minutes') ?? 0));
  const [late, setLate] = useState(String(effective(record, 'late_minutes') ?? 0));
  const [ot, setOt] = useState(String(effective(record, 'overtime_minutes') ?? 0));
  const [note, setNote] = useState('');

  return (
    <div className="border-t border-gray-200 bg-amber-50 px-4 py-3">
      <p className="text-xs font-semibold text-amber-800">
        Correct this day — values below override the computed numbers (all in minutes).
      </p>
      <div className="mt-2 flex flex-wrap items-end gap-3">
        <label className="text-xs text-gray-600">
          Worked
          <input value={worked} onChange={(e) => setWorked(e.target.value.replace(/\D/g, ''))}
            className="mt-1 block w-24 input" />
        </label>
        <label className="text-xs text-gray-600">
          Late
          <input value={late} onChange={(e) => setLate(e.target.value.replace(/\D/g, ''))}
            className="mt-1 block w-20 input" />
        </label>
        <label className="text-xs text-gray-600">
          Overtime
          <input value={ot} onChange={(e) => setOt(e.target.value.replace(/\D/g, ''))}
            className="mt-1 block w-20 input" />
        </label>
        <label className="min-w-64 flex-1 text-xs text-gray-600">
          Reason (required)
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. forgot to clock out, confirmed with branch manager"
            className="mt-1 block w-full input" />
        </label>
        <button
          onClick={() => onSave(note, {
            worked_minutes: Number(worked || 0),
            late_minutes: Number(late || 0),
            overtime_minutes: Number(ot || 0),
          })}
          disabled={!note.trim()}
          className="btn-primary"
        >
          Save correction
        </button>
        <button onClick={onCancel} className="btn">
          Cancel
        </button>
      </div>
    </div>
  );
}

interface FilterOption {
  id: string;
  full_name?: string;
  employee_code?: string;
  name?: string;
}

export function Reviews() {
  const { profile } = useAuth();
  const [rows, setRows] = useState<RecordRow[]>([]);
  const [statusFilter, setStatusFilter] = useState<string>('pending_review');
  const [openId, setOpenId] = useState<string | null>(null);
  const [correctId, setCorrectId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Extra filters (RLS already scopes visibility; these narrow within it).
  const [employees, setEmployees] = useState<FilterOption[]>([]);
  const [branches, setBranches] = useState<FilterOption[]>([]);
  const [employeeId, setEmployeeId] = useState('');
  const [branchId, setBranchId] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  const canReview = profile ? REVIEWER_ROLES.includes(profile.role) : false;

  useEffect(() => {
    supabase
      .from('profiles')
      .select('id, full_name, employee_code')
      .order('full_name')
      .then(({ data }) => setEmployees((data as FilterOption[]) ?? []));
    supabase
      .from('branches')
      .select('id, name')
      .eq('is_active', true)
      .order('name')
      .then(({ data }) => setBranches((data as FilterOption[]) ?? []));
  }, []);

  // Discard out-of-order responses when filters change quickly.
  const loadSeq = useRef(0);

  const load = useCallback(() => {
    const seq = ++loadSeq.current;
    let q = supabase
      .from('attendance_records')
      .select(
        'id, work_date, status, review_note, reviewed_at, worked_minutes, break_minutes, late_minutes, undertime_minutes, overtime_minutes, day_class, flags, corrections, employee:profiles!attendance_records_employee_id_fkey(id, full_name, employee_code), branch:branches(name, shift_start, shift_end), reviewer:profiles!attendance_records_reviewed_by_fkey(full_name)',
      )
      .order('work_date', { ascending: false })
      .limit(100);
    if (statusFilter !== 'all') q = q.eq('status', statusFilter);
    if (employeeId) q = q.eq('employee_id', employeeId);
    if (branchId) q = q.eq('branch_id', branchId);
    if (fromDate) q = q.gte('work_date', fromDate);
    if (toDate) q = q.lte('work_date', toDate);
    q.then(({ data }) => {
      if (seq !== loadSeq.current) return; // a newer load superseded this one
      setRows((data as unknown as RecordRow[]) ?? []);
    });
  }, [statusFilter, employeeId, branchId, fromDate, toDate]);

  useEffect(load, [load]);

  const review = async (
    id: string,
    status: AttendanceStatus,
    note: string | null = null,
    corrections: Record<string, number> | null = null,
  ) => {
    setError(null);
    if (status === 'rejected' && !note) {
      note = window.prompt('Reason for rejection:');
      if (!note?.trim()) return;
    }
    const { error: rpcErr } = await supabase.rpc('review_attendance', {
      p_record_id: id,
      p_status: status,
      p_note: note,
      p_corrections: corrections,
    });
    if (rpcErr) setError(rpcErr.message);
    else {
      setCorrectId(null);
      load();
    }
  };

  return (
    <div className="mx-auto max-w-5xl">
      <div>
        <h2 className="text-lg font-semibold text-ink">Attendance reviews</h2>
        <p className="text-sm text-gray-500">
          {canReview
            ? 'Only approved attendance becomes official. Rejections and corrections require a note.'
            : 'View-only: approvals are handled by HR, operations, or super admin.'}
        </p>
      </div>

      <div className="mt-4 flex flex-wrap items-end gap-3 card p-4">
        <label className="text-sm">
          <span className="block text-xs font-medium text-gray-500">Status</span>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="mt-1 input">
            <option value="pending_review">Pending review</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
            <option value="corrected">Corrected</option>
            <option value="all">All</option>
          </select>
        </label>
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

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      <div className="mt-4 overflow-hidden card">
        <table className="w-full text-left text-sm">
          <thead className="bg-ground text-muted">
            <tr>
              <th className="px-4 py-2 font-medium">Date</th>
              <th className="px-4 py-2 font-medium">Employee</th>
              <th className="px-4 py-2 font-medium">Worked</th>
              <th className="px-4 py-2 font-medium">Late / OT</th>
              <th className="px-4 py-2 font-medium">Flags</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-center text-gray-400">
                  Nothing here — punches create review entries automatically.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <>
                <tr key={r.id} className="hover:bg-gray-50">
                  <td className="whitespace-nowrap px-4 py-2 text-gray-900">
                    {r.work_date}
                    {r.day_class && DAY_CLASS_LABEL[r.day_class] && (
                      <span className="ml-1.5 rounded-full bg-purple-100 px-1.5 py-0.5 text-[10px] text-purple-700">
                        {DAY_CLASS_LABEL[r.day_class]}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    <span className="font-medium text-gray-900">{r.employee?.full_name ?? '—'}</span>
                    <span className="block text-xs text-gray-500">
                      {r.employee?.employee_code} · {r.branch?.name ?? 'no branch'}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 text-gray-900">
                    {fmtMinutes(effective(r, 'worked_minutes'))}
                    {r.corrections && <span className="ml-1 text-xs text-sky-600" title="corrected by HR">✏️</span>}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 text-xs text-gray-600">
                    {effective(r, 'late_minutes') ? `late ${effective(r, 'late_minutes')}m` : '—'}
                    {' / '}
                    {effective(r, 'overtime_minutes') ? `OT ${effective(r, 'overtime_minutes')}m` : '—'}
                  </td>
                  <td className="px-4 py-2">
                    <span className="flex flex-wrap gap-1">
                      {(r.flags ?? []).map((f) => (
                        <span key={f} className={`rounded-full px-1.5 py-0.5 text-[10px] ${FLAG_BADGE[f] ?? 'bg-gray-100 text-gray-600'}`}>
                          {f.replace(/_/g, ' ')}
                        </span>
                      ))}
                    </span>
                  </td>
                  <td className="px-4 py-2">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs ${STATUS_BADGE[r.status]}`}
                      title={r.review_note ?? ''}
                    >
                      {STATUS_LABEL[r.status]}
                    </span>
                  </td>
                  <td className="space-x-2 whitespace-nowrap px-4 py-2 text-right">
                    <button
                      onClick={() => setOpenId(openId === r.id ? null : r.id)}
                      className="text-sm text-brand-700 hover:underline"
                    >
                      {openId === r.id ? 'Hide' : 'Punches'}
                    </button>
                    {canReview && r.status === 'pending_review' && (
                      <>
                        <button
                          onClick={() => review(r.id, 'approved')}
                          className="rounded-lg bg-green-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-green-700"
                        >
                          Approve
                        </button>
                        <button
                          onClick={() => review(r.id, 'rejected')}
                          className="rounded-lg bg-red-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-red-700"
                        >
                          Reject
                        </button>
                      </>
                    )}
                    {/* Correct stays available after approval — an approved day can still be
                        adjusted (it becomes `corrected`, which is still payable). */}
                    {canReview && r.status !== 'rejected' && (
                      <button
                        onClick={() => setCorrectId(correctId === r.id ? null : r.id)}
                        className="btn px-2.5 py-1 text-xs"
                      >
                        {correctId === r.id ? 'Close' : 'Correct'}
                      </button>
                    )}
                  </td>
                </tr>
                {correctId === r.id && (
                  <tr key={`${r.id}-correct`}>
                    <td colSpan={7} className="p-0">
                      <CorrectionForm
                        record={r}
                        onSave={(note, corrections) => void review(r.id, 'corrected', note, corrections)}
                        onCancel={() => setCorrectId(null)}
                      />
                    </td>
                  </tr>
                )}
                {openId === r.id && (
                  <tr key={`${r.id}-detail`}>
                    <td colSpan={7} className="p-0">
                      <DayDetail record={r} />
                    </td>
                  </tr>
                )}
              </>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
