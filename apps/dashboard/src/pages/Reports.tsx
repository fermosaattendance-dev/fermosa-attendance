import {
  COMPANY_WIDE_ROLES,
  formatPeriodLabel,
  payPeriodFor,
  semiMonthlyPeriods,
  type PayPeriod,
  type PayrollSummaryRow,
  type PayrollSyncLog,
} from '@fermosa/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../lib/auth';
import { supabase } from '../lib/supabase';
import { exportCsv, exportXlsx, type Cell } from '../lib/exportTable';

type ReportType = 'payroll' | 'branch' | 'daily' | 'timesheet' | 'overtime' | 'leave';

const REPORTS: { key: ReportType; label: string }[] = [
  { key: 'payroll', label: 'Payroll summary' },
  { key: 'branch', label: 'Branch summary' },
  { key: 'daily', label: 'Daily register' },
  { key: 'timesheet', label: 'Employee timesheet' },
  { key: 'overtime', label: 'Overtime' },
  { key: 'leave', label: 'Leave' },
];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

interface EffRow {
  id: string;
  employee_id: string;
  branch_id: string;
  work_date: string;
  status: string;
  day_class: string | null;
  flags: string[] | null;
  first_in: string | null;
  last_out: string | null;
  worked_minutes: number;
  late_minutes: number;
  undertime_minutes: number;
  overtime_minutes: number;
}

interface LeaveRow {
  id: string;
  employee_id: string;
  start_date: string;
  end_date: string;
  half_day: boolean;
  day_count: number;
  status: string;
  reason: string | null;
  employee: { full_name: string; employee_code: string; branch_id: string | null } | null;
  leave_type: { name: string; is_paid: boolean } | null;
}

interface EmployeeLite {
  id: string;
  full_name: string;
  employee_code: string;
  branch_id: string | null;
}

interface BranchLite {
  id: string;
  name: string;
}

const EFF_COLS =
  'id, employee_id, branch_id, work_date, status, day_class, flags, first_in, last_out, worked_minutes, late_minutes, undertime_minutes, overtime_minutes';

const hours = (min: number) => (min / 60).toFixed(2);
const fmtDays = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
const timeManila = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Manila' })
    : '—';

function dayStatus(r: EffRow): string {
  if (r.flags?.includes('on_leave')) return 'On leave';
  if (r.flags?.includes('absent')) return 'Absent';
  if (r.first_in) return 'Present';
  return '—';
}

interface ReportTable {
  headers: string[];
  rows: Cell[][];
  sheetName: string;
  filename: string;
}

export function Reports() {
  const { profile } = useAuth();
  const isCompanyWide = profile ? COMPANY_WIDE_ROLES.includes(profile.role) : false;

  const initial = useMemo(() => payPeriodFor(new Date().toISOString()), []);
  const [reportType, setReportType] = useState<ReportType>('payroll');
  const [year, setYear] = useState(initial.year);
  const [month, setMonth] = useState(initial.month);
  const [half, setHalf] = useState<1 | 2>(initial.half);
  const [dayDate, setDayDate] = useState(new Date().toISOString().slice(0, 10));
  const [branchId, setBranchId] = useState('');
  const [employeeId, setEmployeeId] = useState('');

  const [branches, setBranches] = useState<BranchLite[]>([]);
  const [employees, setEmployees] = useState<EmployeeLite[]>([]);
  const [payrollRows, setPayrollRows] = useState<PayrollSummaryRow[]>([]);
  const [effRows, setEffRows] = useState<EffRow[]>([]);
  const [leaveRows, setLeaveRows] = useState<LeaveRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const period = useMemo(() => {
    const [first, second] = semiMonthlyPeriods(year, month);
    return half === 1 ? first : second;
  }, [year, month, half]);
  const empMap = useMemo(() => new Map(employees.map((e) => [e.id, e])), [employees]);
  const branchMap = useMemo(() => new Map(branches.map((b) => [b.id, b.name])), [branches]);

  useEffect(() => {
    supabase
      .from('branches')
      .select('id, name')
      .order('name')
      .then(({ data }) => setBranches((data as BranchLite[]) ?? []));
    supabase
      .from('profiles')
      .select('id, full_name, employee_code, branch_id')
      .order('full_name')
      .then(({ data }) => setEmployees((data as EmployeeLite[]) ?? []));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const branchArg = branchId || null;
    try {
      if (reportType === 'payroll' || reportType === 'branch') {
        const { data, error: err } = await supabase.rpc('report_payroll_summary', {
          p_from: period.start,
          p_to: period.end,
          p_branch_id: branchArg,
        });
        if (err) throw err;
        setPayrollRows((data as PayrollSummaryRow[]) ?? []);
      } else if (reportType === 'daily') {
        let q = supabase.from('attendance_effective').select(EFF_COLS).eq('work_date', dayDate);
        if (branchArg) q = q.eq('branch_id', branchArg);
        const { data, error: err } = await q;
        if (err) throw err;
        setEffRows((data as EffRow[]) ?? []);
      } else if (reportType === 'timesheet') {
        if (!employeeId) {
          setEffRows([]);
          return;
        }
        const { data, error: err } = await supabase
          .from('attendance_effective')
          .select(EFF_COLS)
          .eq('employee_id', employeeId)
          .gte('work_date', period.start)
          .lte('work_date', period.end)
          .order('work_date');
        if (err) throw err;
        setEffRows((data as EffRow[]) ?? []);
      } else if (reportType === 'overtime') {
        let q = supabase
          .from('attendance_effective')
          .select(EFF_COLS)
          .gt('overtime_minutes', 0)
          .gte('work_date', period.start)
          .lte('work_date', period.end);
        if (branchArg) q = q.eq('branch_id', branchArg);
        const { data, error: err } = await q;
        if (err) throw err;
        setEffRows((data as EffRow[]) ?? []);
      } else if (reportType === 'leave') {
        const { data, error: err } = await supabase
          .from('leave_requests')
          .select(
            'id, employee_id, start_date, end_date, half_day, day_count, status, reason, employee:profiles!leave_requests_employee_id_fkey(full_name, employee_code, branch_id), leave_type:leave_types(name, is_paid)',
          )
          .eq('status', 'approved')
          .lte('start_date', period.end)
          .gte('end_date', period.start)
          .order('start_date');
        if (err) throw err;
        setLeaveRows((data as unknown as LeaveRow[]) ?? []);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [reportType, period, dayDate, branchId, employeeId]);

  useEffect(() => {
    load();
  }, [load]);

  const table = useMemo<ReportTable>(() => {
    const periodTag = `${year}-${String(month).padStart(2, '0')}_${half === 1 ? '1-15' : '16-eom'}`;
    const nameOf = (id: string) => empMap.get(id)?.full_name ?? '';

    switch (reportType) {
      case 'payroll': {
        const headers = [
          'Code', 'Name', 'Branch', 'Present', 'Absent', 'Worked (h)', 'Late (min)',
          'Undertime (min)', 'OT (min)', 'Paid leave', 'Unpaid leave', 'Rest-days worked', 'Holidays worked',
        ];
        const rows: Cell[][] = payrollRows.map((r) => [
          r.employee_code, r.full_name, r.branch_name, r.days_present, r.days_absent,
          hours(r.worked_minutes), r.late_minutes, r.undertime_minutes, r.overtime_minutes,
          fmtDays(r.paid_leave_days), fmtDays(r.unpaid_leave_days), r.rest_days_worked, r.holidays_worked,
        ]);
        return { headers, rows, sheetName: 'Payroll', filename: `payroll_${periodTag}` };
      }
      case 'branch': {
        const agg = new Map<
          string,
          { branch: string; emps: number; present: number; absent: number; worked: number; late: number; ot: number; paid: number; unpaid: number }
        >();
        for (const r of payrollRows) {
          const cur = agg.get(r.branch_id) ?? {
            branch: r.branch_name, emps: 0, present: 0, absent: 0, worked: 0, late: 0, ot: 0, paid: 0, unpaid: 0,
          };
          cur.emps += 1;
          cur.present += r.days_present;
          cur.absent += r.days_absent;
          cur.worked += r.worked_minutes;
          cur.late += r.late_minutes;
          cur.ot += r.overtime_minutes;
          cur.paid += r.paid_leave_days;
          cur.unpaid += r.unpaid_leave_days;
          agg.set(r.branch_id, cur);
        }
        const headers = ['Branch', 'Employees', 'Present days', 'Absent days', 'Worked (h)', 'Late (min)', 'OT (min)', 'Paid leave', 'Unpaid leave'];
        const rows: Cell[][] = [...agg.values()]
          .sort((a, b) => a.branch.localeCompare(b.branch))
          .map((a) => [a.branch, a.emps, a.present, a.absent, hours(a.worked), a.late, a.ot, fmtDays(a.paid), fmtDays(a.unpaid)]);
        return { headers, rows, sheetName: 'Branch summary', filename: `branch_summary_${periodTag}` };
      }
      case 'daily': {
        const headers = ['Code', 'Name', 'Branch', 'Status', 'In', 'Out', 'Worked (h)', 'Late (min)', 'Flags', 'Approval'];
        const rows: Cell[][] = [...effRows]
          .sort((a, b) => nameOf(a.employee_id).localeCompare(nameOf(b.employee_id)))
          .map((r) => {
            const e = empMap.get(r.employee_id);
            return [
              e?.employee_code ?? '—', e?.full_name ?? '—', branchMap.get(r.branch_id) ?? '—', dayStatus(r),
              timeManila(r.first_in), timeManila(r.last_out), hours(r.worked_minutes), r.late_minutes,
              (r.flags ?? []).join(', '), r.status,
            ];
          });
        return { headers, rows, sheetName: 'Daily register', filename: `daily_register_${dayDate}` };
      }
      case 'timesheet': {
        const headers = ['Date', 'Day class', 'In', 'Out', 'Worked (h)', 'Late (min)', 'Undertime (min)', 'OT (min)', 'Flags', 'Approval'];
        const rows: Cell[][] = [...effRows]
          .sort((a, b) => a.work_date.localeCompare(b.work_date))
          .map((r) => [
            r.work_date, r.day_class ?? '—', timeManila(r.first_in), timeManila(r.last_out), hours(r.worked_minutes),
            r.late_minutes, r.undertime_minutes, r.overtime_minutes, (r.flags ?? []).join(', '), r.status,
          ]);
        const tag = empMap.get(employeeId)?.employee_code ?? 'employee';
        return { headers, rows, sheetName: 'Timesheet', filename: `timesheet_${tag}_${periodTag}` };
      }
      case 'overtime': {
        const headers = ['Date', 'Code', 'Name', 'Branch', 'OT (min)', 'OT (h)', 'Worked (h)', 'Approval'];
        const rows: Cell[][] = [...effRows]
          .sort((a, b) => a.work_date.localeCompare(b.work_date))
          .map((r) => {
            const e = empMap.get(r.employee_id);
            return [
              r.work_date, e?.employee_code ?? '—', e?.full_name ?? '—', branchMap.get(r.branch_id) ?? '—',
              r.overtime_minutes, hours(r.overtime_minutes), hours(r.worked_minutes), r.status,
            ];
          });
        return { headers, rows, sheetName: 'Overtime', filename: `overtime_${periodTag}` };
      }
      case 'leave': {
        const headers = ['Code', 'Name', 'Type', 'Paid', 'Start', 'End', 'Days', 'Half-day', 'Status', 'Reason'];
        const rows: Cell[][] = leaveRows
          .filter((r) => !branchId || r.employee?.branch_id === branchId)
          .map((r) => [
            r.employee?.employee_code ?? '—', r.employee?.full_name ?? '—', r.leave_type?.name ?? '—',
            r.leave_type?.is_paid ? 'Paid' : 'Unpaid', r.start_date, r.end_date, fmtDays(r.day_count),
            r.half_day ? 'Yes' : '', r.status, r.reason ?? '',
          ]);
        return { headers, rows, sheetName: 'Leave', filename: `leave_${periodTag}` };
      }
    }
  }, [reportType, payrollRows, effRows, leaveRows, year, month, half, dayDate, branchId, employeeId, empMap, branchMap]);

  if (!profile) return null;

  const scopeLabel = reportType === 'daily' ? dayDate : formatPeriodLabel(period);
  const showPeriod = reportType !== 'daily';
  const canExport = table.rows.length > 0;
  const years = [initial.year - 1, initial.year, initial.year + 1];

  return (
    <div className="mx-auto max-w-6xl">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">Reports</h2>
        <p className="text-sm text-gray-500">
          Attendance &amp; payroll reports, scoped to your access. Export to Excel or CSV.
        </p>
      </div>

      <div className="mt-4 flex flex-wrap gap-1 rounded-lg border border-gray-200 bg-white p-1 text-sm">
        {REPORTS.map((r) => (
          <button
            key={r.key}
            onClick={() => setReportType(r.key)}
            className={`rounded-md px-3 py-1.5 ${reportType === r.key ? 'bg-brand-600 text-white' : 'text-gray-600 hover:bg-gray-100'}`}
          >
            {r.label}
          </button>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap items-end gap-3 rounded-xl border border-gray-200 bg-white p-4">
        {showPeriod && (
          <>
            <label className="text-sm">
              <span className="block text-xs font-medium text-gray-500">Month</span>
              <select
                value={month}
                onChange={(e) => setMonth(Number(e.target.value))}
                className="mt-1 rounded-lg border border-gray-300 px-3 py-2 text-sm"
              >
                {MONTHS.map((m, i) => (
                  <option key={m} value={i + 1}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              <span className="block text-xs font-medium text-gray-500">Year</span>
              <select
                value={year}
                onChange={(e) => setYear(Number(e.target.value))}
                className="mt-1 rounded-lg border border-gray-300 px-3 py-2 text-sm"
              >
                {years.map((y) => (
                  <option key={y} value={y}>
                    {y}
                  </option>
                ))}
              </select>
            </label>
            <div className="text-sm">
              <span className="block text-xs font-medium text-gray-500">Period</span>
              <div className="mt-1 flex gap-1">
                <button
                  onClick={() => setHalf(1)}
                  className={`rounded-lg px-3 py-2 text-sm ${half === 1 ? 'bg-brand-600 text-white' : 'border border-gray-300 text-gray-600'}`}
                >
                  1–15
                </button>
                <button
                  onClick={() => setHalf(2)}
                  className={`rounded-lg px-3 py-2 text-sm ${half === 2 ? 'bg-brand-600 text-white' : 'border border-gray-300 text-gray-600'}`}
                >
                  16–EOM
                </button>
              </div>
            </div>
          </>
        )}

        {reportType === 'daily' && (
          <label className="text-sm">
            <span className="block text-xs font-medium text-gray-500">Date</span>
            <input
              type="date"
              value={dayDate}
              onChange={(e) => setDayDate(e.target.value)}
              className="mt-1 rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
          </label>
        )}

        {reportType === 'timesheet' && (
          <label className="text-sm">
            <span className="block text-xs font-medium text-gray-500">Employee</span>
            <select
              value={employeeId}
              onChange={(e) => setEmployeeId(e.target.value)}
              className="mt-1 rounded-lg border border-gray-300 px-3 py-2 text-sm"
            >
              <option value="">Select…</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.full_name} ({e.employee_code})
                </option>
              ))}
            </select>
          </label>
        )}

        {isCompanyWide && reportType !== 'timesheet' && (
          <label className="text-sm">
            <span className="block text-xs font-medium text-gray-500">Branch</span>
            <select
              value={branchId}
              onChange={(e) => setBranchId(e.target.value)}
              className="mt-1 rounded-lg border border-gray-300 px-3 py-2 text-sm"
            >
              <option value="">All branches</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
        )}

        <div className="ml-auto flex gap-2">
          <button
            disabled={!canExport}
            onClick={() => exportXlsx(table.filename, [{ name: table.sheetName, headers: table.headers, rows: table.rows }])}
            className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-40"
          >
            Export Excel
          </button>
          <button
            disabled={!canExport}
            onClick={() => exportCsv(table.filename, table.headers, table.rows)}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 disabled:opacity-40"
          >
            Export CSV
          </button>
        </div>
      </div>

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      <div className="mt-3 flex items-center justify-between text-xs text-gray-500">
        <span>
          {scopeLabel} · {table.rows.length} row{table.rows.length === 1 ? '' : 's'}
        </span>
        {loading && <span>Loading…</span>}
      </div>

      <div className="mt-1 overflow-x-auto rounded-xl border border-gray-200 bg-white">
        <table className="w-full text-left text-sm">
          <thead className="bg-gray-50 text-gray-600">
            <tr>
              {table.headers.map((h) => (
                <th key={h} className="whitespace-nowrap px-3 py-2 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {table.rows.length === 0 && (
              <tr>
                <td colSpan={table.headers.length} className="px-4 py-6 text-center text-gray-400">
                  {reportType === 'timesheet' && !employeeId ? 'Select an employee.' : 'No data for this selection.'}
                </td>
              </tr>
            )}
            {table.rows.map((row, i) => (
              <tr key={i} className="hover:bg-gray-50">
                {row.map((cell, j) => (
                  <td key={j} className="whitespace-nowrap px-3 py-2 text-gray-700">
                    {cell === null || cell === '' ? <span className="text-gray-300">—</span> : cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {reportType === 'payroll' && isCompanyWide && (
        <PayrollSyncPanel period={period} branchId={branchId} rowCount={table.rows.length} />
      )}
    </div>
  );
}

function PayrollSyncPanel({ period, branchId, rowCount }: { period: PayPeriod; branchId: string; rowCount: number }) {
  const [dryRun, setDryRun] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<PayrollSyncLog[]>([]);

  const loadRecent = useCallback(() => {
    supabase
      .from('payroll_syncs')
      .select('*')
      .order('synced_at', { ascending: false })
      .limit(8)
      .then(({ data }) => setRecent((data as PayrollSyncLog[]) ?? []));
  }, []);

  useEffect(() => {
    loadRecent();
  }, [loadRecent]);

  const sync = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    const { data, error: err } = await supabase.functions.invoke('payroll-sync', {
      body: {
        period_start: period.start,
        period_end: period.end,
        branch_id: branchId || null,
        sheet_tab: formatPeriodLabel(period),
        dry_run: dryRun,
      },
    });
    setBusy(false);
    if (err) {
      setError(err.message);
      return;
    }
    if (data?.ok) {
      setResult(
        data.dryRun
          ? `Dry run — ${data.rowCount} row(s) prepared for tab “${data.tab}” (${data.reason}). No sheet written.`
          : `Synced ${data.rowCount} row(s) to tab “${data.tab}”.`,
      );
    } else {
      setError(data?.error ?? 'Sync failed.');
    }
    loadRecent();
  };

  return (
    <div className="mt-6 rounded-xl border border-gray-200 bg-white p-4">
      <h3 className="text-sm font-semibold text-gray-900">Payroll sync → Google Sheets</h3>
      <p className="mt-0.5 text-xs text-gray-500">
        Pushes the approved payroll rows for {formatPeriodLabel(period)} to the tab “{formatPeriodLabel(period)}”.
        Re-syncing overwrites that tab. Runs as a dry run until Google credentials are configured.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          onClick={sync}
          disabled={busy}
          className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
        >
          {busy ? 'Syncing…' : dryRun ? 'Dry-run sync' : 'Sync to Google Sheets'}
        </button>
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
          Dry run (don’t write to the sheet)
        </label>
        <span className="text-xs text-gray-400">{rowCount} row(s) in view</span>
      </div>
      {result && <p className="mt-2 text-sm text-green-700">{result}</p>}
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

      {recent.length > 0 && (
        <div className="mt-4">
          <div className="text-xs font-medium text-gray-500">Recent syncs</div>
          <table className="mt-1 w-full text-left text-xs">
            <thead className="text-gray-500">
              <tr>
                <th className="py-1 pr-3 font-medium">When</th>
                <th className="py-1 pr-3 font-medium">Period</th>
                <th className="py-1 pr-3 font-medium">Tab</th>
                <th className="py-1 pr-3 font-medium">Rows</th>
                <th className="py-1 pr-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="text-gray-600">
              {recent.map((s) => (
                <tr key={s.id} className="border-t border-gray-100">
                  <td className="py-1 pr-3">{new Date(s.synced_at).toLocaleString('en-PH', { timeZone: 'Asia/Manila' })}</td>
                  <td className="py-1 pr-3">
                    {s.period_start} → {s.period_end}
                  </td>
                  <td className="py-1 pr-3">{s.sheet_tab}</td>
                  <td className="py-1 pr-3">{s.row_count}</td>
                  <td className="py-1 pr-3">
                    <span
                      className={`rounded-full px-2 py-0.5 ${
                        s.status === 'synced'
                          ? 'bg-green-100 text-green-700'
                          : s.status === 'failed'
                            ? 'bg-red-100 text-red-700'
                            : 'bg-gray-100 text-gray-600'
                      }`}
                    >
                      {s.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
