import {
  COMPANY_WIDE_ROLES,
  EMPTY_MANUAL_AMOUNTS,
  computePayslip,
  formatPeriodLabel,
  payPeriodFor,
  semiMonthlyPeriods,
  type PayrollSummaryRow,
  type PayslipManualAmounts,
} from '@fermosa/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { PageHeader } from '../components/PageHeader';
import { PayslipView } from '../components/PayslipView';
import { useAuth } from '../lib/auth';
import { exportXlsx, type Cell } from '../lib/exportTable';
import { matchByCode, parseSheet, readPayslipSheet, type ParsedRow } from '../lib/importTable';
import { supabase } from '../lib/supabase';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Sheet column order — also the order HR sees in the template. */
const TEMPLATE_HEADERS = [
  'Employee code',
  'Name',
  'Add allowance',
  'Holiday',
  'Others less',
  'Adjustment less',
  'Cash advance',
  'SSS',
  'PhilHealth',
  'Pag-IBIG',
  'Others',
];

const AMOUNT_FIELDS: { key: keyof PayslipManualAmounts; label: string }[] = [
  { key: 'add_allowance', label: 'Add allowance' },
  { key: 'holiday_pay', label: 'Holiday' },
  { key: 'others_less', label: 'Others less' },
  { key: 'adjustment_less', label: 'Adjustment less' },
  { key: 'cash_advance', label: 'Cash advance' },
  { key: 'sss', label: 'SSS' },
  { key: 'philhealth', label: 'PhilHealth' },
  { key: 'pagibig', label: 'Pag-IBIG' },
  { key: 'others', label: 'Others' },
];

const peso = (n: number) =>
  n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const stampFmt = new Intl.DateTimeFormat('en-PH', {
  timeZone: 'Asia/Manila',
  dateStyle: 'medium',
  timeStyle: 'short',
});

interface AdjRow extends PayslipManualAmounts {
  employee_id: string;
}

interface PreviewRow extends ParsedRow {
  employee_id: string | null;
  dbName: string | null;
}

export function Payslips() {
  const { profile } = useAuth();
  const isAdmin = profile ? COMPANY_WIDE_ROLES.includes(profile.role) : false;

  const initial = useMemo(() => payPeriodFor(new Date().toISOString()), []);
  const [year, setYear] = useState(initial.year);
  const [month, setMonth] = useState(initial.month);
  const [half, setHalf] = useState<1 | 2>(initial.half);
  const [employeeId, setEmployeeId] = useState('');

  const [summary, setSummary] = useState<PayrollSummaryRow[]>([]);
  const [adjustments, setAdjustments] = useState<Record<string, PayslipManualAmounts>>({});
  const [hired, setHired] = useState<Record<string, string | null>>({});
  const [leaveLeft, setLeaveLeft] = useState<Record<string, number>>({});
  const [codes, setCodes] = useState<{ id: string; code: string; name: string }[]>([]);
  const [publishedAt, setPublishedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [preview, setPreview] = useState<PreviewRow[] | null>(null);
  const [previewNote, setPreviewNote] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);

  const period = useMemo(() => {
    const [first, second] = semiMonthlyPeriods(year, month);
    return half === 1 ? first! : second!;
  }, [year, month, half]);

  // A deployed cutoff is final: staff can see it, so the amounts lock (the DB
  // enforces this too — the UI just matches).
  const isDeployed = !!publishedAt;

  const load = useCallback(async () => {
    if (!isAdmin) return;
    setLoading(true);
    setError(null);
    const [sum, adj, profs, bal, per] = await Promise.all([
      supabase.rpc('report_payroll_summary', {
        p_from: period.start,
        p_to: period.end,
        p_branch_id: null,
      }),
      supabase.from('payroll_adjustments').select('*').eq('period_start', period.start),
      supabase.from('profiles').select('id, employee_code, full_name, date_hired').order('full_name'),
      supabase
        .from('leave_balances_view')
        .select('employee_id, remaining_days')
        .eq('year', new Date().getFullYear()),
      supabase.from('payroll_periods').select('published_at').eq('period_start', period.start).maybeSingle(),
    ]);
    if (sum.error) setError(sum.error.message);
    setSummary((sum.data as PayrollSummaryRow[]) ?? []);
    setPublishedAt(((per.data as { published_at: string | null } | null) ?? null)?.published_at ?? null);

    const map: Record<string, PayslipManualAmounts> = {};
    for (const r of ((adj.data as AdjRow[]) ?? [])) {
      map[r.employee_id] = {
        add_allowance: Number(r.add_allowance),
        holiday_pay: Number(r.holiday_pay),
        others_less: Number(r.others_less),
        adjustment_less: Number(r.adjustment_less),
        cash_advance: Number(r.cash_advance),
        sss: Number(r.sss),
        philhealth: Number(r.philhealth),
        pagibig: Number(r.pagibig),
        others: Number(r.others),
      };
    }
    setAdjustments(map);

    const rows =
      (profs.data as { id: string; employee_code: string; full_name: string; date_hired: string | null }[]) ?? [];
    setCodes(rows.map((p) => ({ id: p.id, code: p.employee_code, name: p.full_name })));
    setHired(Object.fromEntries(rows.map((p) => [p.id, p.date_hired])));

    const left: Record<string, number> = {};
    for (const b of ((bal.data as { employee_id: string; remaining_days: number }[]) ?? [])) {
      left[b.employee_id] = (left[b.employee_id] ?? 0) + Number(b.remaining_days);
    }
    setLeaveLeft(left);
    setLoading(false);
  }, [isAdmin, period.start, period.end]);

  useEffect(() => {
    void load();
  }, [load]);

  const amountsFor = (id: string): PayslipManualAmounts => adjustments[id] ?? { ...EMPTY_MANUAL_AMOUNTS };

  // ---- Deploy --------------------------------------------------------------
  const deploy = async () => {
    if (
      !window.confirm(
        `Deploy the ${formatPeriodLabel(period)} payslips to all ${summary.length} employee(s)?\n\n` +
          'They will be able to see their own payslip, and the amounts will lock until you un-deploy.',
      )
    )
      return;
    setError(null);
    const { error: e } = await supabase.rpc('publish_payroll_period', {
      p_period_start: period.start,
      p_period_end: period.end,
    });
    if (e) setError(e.message);
    else {
      setNotice(`Deployed — staff can now see their ${formatPeriodLabel(period)} payslip.`);
      void load();
    }
  };

  const undeploy = async () => {
    if (!window.confirm('Un-deploy this cutoff? Staff will stop seeing it and you can edit again.')) return;
    setError(null);
    const { error: e } = await supabase.rpc('unpublish_payroll_period', { p_period_start: period.start });
    if (e) setError(e.message);
    else {
      setNotice('Un-deployed — the amounts are editable again.');
      void load();
    }
  };

  // ---- Template ------------------------------------------------------------
  const downloadTemplate = () => {
    const rows: Cell[][] = codes.map((c) => {
      const a = amountsFor(c.id);
      return [
        c.code,
        c.name,
        a.add_allowance || '',
        a.holiday_pay || '',
        a.others_less || '',
        a.adjustment_less || '',
        a.cash_advance || '',
        a.sss || '',
        a.philhealth || '',
        a.pagibig || '',
        a.others || '',
      ];
    });
    exportXlsx(`payroll-input_${period.start}_to_${period.end}`, [
      { name: 'Payroll input', headers: TEMPLATE_HEADERS, rows },
    ]);
  };

  // ---- Upload --------------------------------------------------------------
  const onFile = async (file: File) => {
    setError(null);
    setNotice(null);
    setPreview(null);
    try {
      const cells = await parseSheet(file);
      const res = readPayslipSheet(cells);
      if (res.error) {
        setError(res.error);
        return;
      }
      const rows: PreviewRow[] = res.rows.map((r) => {
        // Exact code first, then a leading-zero-insensitive fallback (Excel
        // turns "0005" into 5) — only when it resolves to exactly one person.
        const hit = matchByCode(r.code, codes);
        return { ...r, employee_id: hit?.id ?? null, dbName: hit?.name ?? null };
      });
      setPreview(rows);
      setPreviewNote(
        `Read ${rows.length} row(s) from ${file.name}.` +
          (res.unknownColumns.length ? ` Ignored columns: ${res.unknownColumns.join(', ')}.` : ''),
      );
    } catch (e) {
      setError(`Could not read that file: ${(e as Error).message}`);
    }
  };

  const applyPreview = async () => {
    if (!preview) return;
    const good = preview.filter((r) => r.employee_id && r.invalid.length === 0);
    if (good.length === 0) {
      setError('Nothing to apply — no rows matched an employee code.');
      return;
    }
    setApplying(true);
    setError(null);
    const { error: upErr } = await supabase.from('payroll_adjustments').upsert(
      good.map((r) => ({
        employee_id: r.employee_id!,
        period_start: period.start,
        period_end: period.end,
        ...r.amounts,
      })),
      { onConflict: 'employee_id,period_start' },
    );
    setApplying(false);
    if (upErr) {
      setError(upErr.message);
      return;
    }
    setPreview(null);
    setNotice(`Applied ${good.length} employee(s) for ${formatPeriodLabel(period)}.`);
    void load();
  };

  // ---- Single payslip ------------------------------------------------------
  const row = summary.find((s) => s.employee_id === employeeId) ?? null;
  const [draft, setDraft] = useState<PayslipManualAmounts | null>(null);
  useEffect(() => {
    setDraft(employeeId ? amountsFor(employeeId) : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employeeId, adjustments]);

  const saveOne = async () => {
    if (!employeeId || !draft) return;
    setError(null);
    const { error: upErr } = await supabase.from('payroll_adjustments').upsert(
      { employee_id: employeeId, period_start: period.start, period_end: period.end, ...draft },
      { onConflict: 'employee_id,period_start' },
    );
    if (upErr) setError(upErr.message);
    else {
      setNotice('Payslip amounts saved.');
      void load();
    }
  };

  if (!profile) return null;
  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-2xl">
        <PageHeader title="Payslips" crumb="Payslips" />
        <div className="card p-6 text-sm text-muted">Payslips are visible to HR and admins only.</div>
      </div>
    );
  }

  const totals =
    row && draft
      ? computePayslip({
          daily_rate: Number(row.daily_rate ?? 0),
          daily_allowance: Number(row.daily_allowance ?? 0),
          days_present: row.days_present,
          full_days: row.full_days,
          paid_leave_days: row.paid_leave_days,
          ot_pay: Number(row.ot_pay ?? 0),
          ...draft,
        })
      : null;

  const employeeName = codes.find((c) => c.id === employeeId)?.name ?? '';
  const matched = preview?.filter((r) => r.employee_id && !r.invalid.length).length ?? 0;
  const unknown = preview?.filter((r) => !r.employee_id).length ?? 0;
  const bad = preview?.filter((r) => r.employee_id && r.invalid.length).length ?? 0;

  return (
    <div className="mx-auto max-w-4xl">
      <div className="no-print">
        <PageHeader
          title="Payslips"
          crumb="Payslips"
          subtitle="Attendance figures are computed; the other amounts come from your uploaded sheet."
        />

        <div className="flex flex-wrap items-end gap-3 card p-4">
          <label className="text-sm">
            <span className="block text-xs font-medium text-gray-500">Month</span>
            <select value={month} onChange={(e) => setMonth(Number(e.target.value))} className="mt-1 input">
              {MONTHS.map((m, i) => (
                <option key={m} value={i + 1}>{m}</option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="block text-xs font-medium text-gray-500">Year</span>
            <select value={year} onChange={(e) => setYear(Number(e.target.value))} className="mt-1 input">
              {[initial.year - 1, initial.year, initial.year + 1].map((y) => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
          </label>
          <div className="text-sm">
            <span className="block text-xs font-medium text-gray-500">Period</span>
            <div className="mt-1 flex gap-1">
              <button
                onClick={() => setHalf(1)}
                className={`rounded-lg px-3 py-2 text-sm ${half === 1 ? 'bg-brand-500 text-on-gold' : 'border border-gray-300 text-gray-600'}`}
              >
                1–15
              </button>
              <button
                onClick={() => setHalf(2)}
                className={`rounded-lg px-3 py-2 text-sm ${half === 2 ? 'bg-brand-500 text-on-gold' : 'border border-gray-300 text-gray-600'}`}
              >
                16–EOM
              </button>
            </div>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {!isDeployed && (
              <>
                <button onClick={downloadTemplate} className="btn">
                  Download template
                </button>
                <label className="btn cursor-pointer">
                  Upload filled sheet
                  <input
                    type="file"
                    accept=".xlsx,.xls,.csv"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void onFile(f);
                      e.target.value = '';
                    }}
                  />
                </label>
              </>
            )}
            {isDeployed ? (
              <button onClick={() => void undeploy()} className="btn">
                Un-deploy
              </button>
            ) : (
              <button onClick={() => void deploy()} disabled={summary.length === 0} className="btn-primary disabled:opacity-50">
                Deploy to staff
              </button>
            )}
          </div>
        </div>

        {/* Release state */}
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          {isDeployed ? (
            <>
              <span className="pill bg-green-100 text-green-700">
                Deployed {publishedAt ? stampFmt.format(new Date(publishedAt)) : ''}
              </span>
              <span className="text-gray-500">
                Staff can see this cutoff. Amounts are locked — un-deploy to make corrections.
              </span>
            </>
          ) : (
            <>
              <span className="pill bg-amber-100 text-amber-700">Draft</span>
              <span className="text-gray-500">
                Not visible to staff yet. Fill the template, upload it once for the whole period, then Deploy.
              </span>
            </>
          )}
        </div>

        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
        {notice && <p className="mt-3 text-sm text-green-700">{notice}</p>}
        {loading && <p className="mt-3 text-sm text-muted">Loading…</p>}

        {preview && (
          <div className="mt-4 card p-4">
            <h3 className="text-sm font-semibold text-ink">Check before applying</h3>
            <p className="mt-1 text-xs text-gray-500">{previewNote}</p>
            <p className="mt-1 text-sm">
              <span className="font-semibold text-green-700">{matched} matched</span>
              {unknown > 0 && <span className="text-red-600"> · {unknown} unknown code</span>}
              {bad > 0 && <span className="text-amber-700"> · {bad} with a bad number</span>}
            </p>
            <div className="mt-3 max-h-72 overflow-auto rounded-lg border border-line">
              <table className="w-full text-left text-xs">
                <thead className="sticky top-0 bg-ground text-muted">
                  <tr>
                    <th className="px-3 py-2 font-medium">Code</th>
                    <th className="px-3 py-2 font-medium">Employee</th>
                    {AMOUNT_FIELDS.map((f) => (
                      <th key={f.key} className="px-2 py-2 text-right font-medium">{f.label}</th>
                    ))}
                    <th className="px-3 py-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {preview.map((r, i) => (
                    <tr key={i} className={!r.employee_id || r.invalid.length ? 'bg-red-50' : ''}>
                      <td className="px-3 py-1.5 font-mono">{r.code || '—'}</td>
                      <td className="px-3 py-1.5">{r.dbName ?? r.sheetName ?? '—'}</td>
                      {AMOUNT_FIELDS.map((f) => (
                        <td key={f.key} className="px-2 py-1.5 text-right tabular-nums">
                          {r.amounts[f.key] ? peso(r.amounts[f.key]) : ''}
                        </td>
                      ))}
                      <td className="px-3 py-1.5">
                        {!r.employee_id ? (
                          <span className="text-red-600">unknown code</span>
                        ) : r.invalid.length ? (
                          <span className="text-amber-700">bad: {r.invalid.join(', ')}</span>
                        ) : (
                          <span className="text-green-700">ok</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-3 flex gap-2">
              <button
                onClick={() => void applyPreview()}
                disabled={applying || matched === 0}
                className="btn-primary disabled:opacity-50"
              >
                {applying ? 'Applying…' : `Apply to ${matched} employee(s)`}
              </button>
              <button onClick={() => setPreview(null)} className="btn">Cancel</button>
            </div>
          </div>
        )}

        <div className="mt-4 flex flex-wrap items-end gap-3 card p-4">
          <label className="text-sm flex-1">
            <span className="block text-xs font-medium text-gray-500">Employee</span>
            <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} className="mt-1 input w-full">
              <option value="">Select an employee…</option>
              {summary.map((s) => (
                <option key={s.employee_id} value={s.employee_id}>
                  {s.full_name} ({s.employee_code})
                </option>
              ))}
            </select>
          </label>
          {row && (
            <>
              {!isDeployed && (
                <button onClick={() => void saveOne()} className="btn-primary">
                  Save amounts
                </button>
              )}
              <button onClick={() => window.print()} className="btn">Print</button>
            </>
          )}
        </div>
      </div>

      {employeeId && !row && !loading && (
        <div className="mt-4 card p-6 text-sm text-muted no-print">
          No approved attendance for this employee in {formatPeriodLabel(period)}. Approve their days on
          Reviews first.
        </div>
      )}

      {row && totals && draft && (
        <div className="mt-4">
          <PayslipView
            employeeName={employeeName}
            employeeCode={row.employee_code}
            branchName={row.branch_name}
            dateHired={hired[employeeId] ?? null}
            leaveRemaining={leaveLeft[employeeId] ?? 0}
            dailyRate={row.daily_rate}
            dailyAllowance={row.daily_allowance}
            periodLabel={formatPeriodLabel(period)}
            periodStart={period.start}
            periodEnd={period.end}
            daysPresent={row.days_present}
            fullDays={row.full_days}
            paidLeaveDays={row.paid_leave_days}
            otPaidHours={row.ot_paid_hours}
            amounts={draft}
            totals={totals}
            onChange={isDeployed ? undefined : setDraft}
            lateChargeHint={row.late_charge}
          />
        </div>
      )}
    </div>
  );
}
