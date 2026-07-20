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

const dateFmt = new Intl.DateTimeFormat('en-PH', { month: 'long', day: 'numeric', year: 'numeric' });

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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Upload preview (nothing is written until Apply).
  const [preview, setPreview] = useState<PreviewRow[] | null>(null);
  const [previewNote, setPreviewNote] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);

  const period = useMemo(() => {
    const [first, second] = semiMonthlyPeriods(year, month);
    return half === 1 ? first! : second!;
  }, [year, month, half]);

  const load = useCallback(async () => {
    if (!isAdmin) return;
    setLoading(true);
    setError(null);
    const [sum, adj, profs, bal] = await Promise.all([
      supabase.rpc('report_payroll_summary', {
        p_from: period.start,
        p_to: period.end,
        p_branch_id: null,
      }),
      supabase.from('payroll_adjustments').select('*').eq('period_start', period.start),
      supabase.from('profiles').select('id, employee_code, full_name, date_hired').order('full_name'),
      supabase.from('leave_balances_view').select('employee_id, remaining_days').eq('year', new Date().getFullYear()),
    ]);
    if (sum.error) setError(sum.error.message);
    setSummary((sum.data as PayrollSummaryRow[]) ?? []);

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

    const rows = (profs.data as { id: string; employee_code: string; full_name: string; date_hired: string | null }[]) ?? [];
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

  // ---- Template ------------------------------------------------------------
  const downloadTemplate = () => {
    const byId = new Map(summary.map((s) => [s.employee_id, s]));
    // Everyone with a profile, so a new hire with no attendance is still listed.
    const rows: Cell[][] = codes
      .filter((c) => byId.has(c.id) || true)
      .map((c) => {
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

  const totals = row && draft
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

        {/* Period + template/upload toolbar */}
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
            <button onClick={downloadTemplate} className="btn">
              Download template
            </button>
            <label className="btn-primary cursor-pointer">
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
          </div>
        </div>

        <p className="mt-2 text-xs text-gray-500">
          Fill the template in Excel and upload it once for the whole period — rows are matched on
          employee code. Employees left out of the sheet keep whatever they already had.
        </p>

        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
        {notice && <p className="mt-3 text-sm text-green-700">{notice}</p>}
        {loading && <p className="mt-3 text-sm text-muted">Loading…</p>}

        {/* Upload preview — nothing is written until Apply */}
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
              <button onClick={() => void applyPreview()} disabled={applying || matched === 0} className="btn-primary disabled:opacity-50">
                {applying ? 'Applying…' : `Apply to ${matched} employee(s)`}
              </button>
              <button onClick={() => setPreview(null)} className="btn">Cancel</button>
            </div>
          </div>
        )}

        {/* Employee picker */}
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
              <button onClick={() => void saveOne()} className="btn-primary">Save amounts</button>
              <button onClick={() => window.print()} className="btn">Print</button>
            </>
          )}
        </div>
      </div>

      {/* ---------------- The payslip ---------------- */}
      {employeeId && !row && !loading && (
        <div className="mt-4 card p-6 text-sm text-muted no-print">
          No approved attendance for this employee in {formatPeriodLabel(period)}. Approve their days
          on Reviews first.
        </div>
      )}

      {row && totals && draft && (
        <div id="payslip" className="mt-4 card p-6">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line pb-3">
            <div>
              <h2 className="text-lg font-bold text-ink">{employeeName}</h2>
              <p className="text-xs text-muted">{row.employee_code} · {row.branch_name}</p>
            </div>
            <div className="text-right text-xs text-muted">
              <div className="font-semibold text-ink">{formatPeriodLabel(period)}</div>
              <div>{dateFmt.format(new Date(`${period.start}T00:00:00`))} – {dateFmt.format(new Date(`${period.end}T00:00:00`))}</div>
            </div>
          </div>

          <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
            <div><dt className="text-xs text-muted">Employment date</dt>
              <dd className="font-medium text-ink">{hired[employeeId] ? dateFmt.format(new Date(`${hired[employeeId]}T00:00:00`)) : '—'}</dd></div>
            <div><dt className="text-xs text-muted">Leave remaining</dt>
              <dd className="font-medium text-ink">{leaveLeft[employeeId] ?? 0}</dd></div>
            <div><dt className="text-xs text-muted">Daily rate</dt>
              <dd className="font-medium text-ink">₱{peso(Number(row.daily_rate ?? 0))}</dd></div>
            <div><dt className="text-xs text-muted">Allowance / full day</dt>
              <dd className="font-medium text-ink">₱{peso(Number(row.daily_allowance ?? 0))}</dd></div>
          </dl>

          {row.daily_rate === null && (
            <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
              No daily rate set for this employee — set it on their profile first.
            </p>
          )}

          <table className="mt-4 w-full text-sm">
            <tbody>
              <Line label={formatPeriodLabel(period)} remark={`${row.days_present} days present`} value={totals.basic} strong />
              <Line label="Allowance" remark={`${row.full_days} full days`} value={totals.allowance} />
              {totals.paid_leave > 0 && <Line label="Paid leave" remark={`${row.paid_leave_days} days`} value={totals.paid_leave} />}
              {totals.overtime > 0 && <Line label="Overtime" remark={`${row.ot_paid_hours} hrs`} value={totals.overtime} />}
              <EditLine label="Add allowance" field="add_allowance" draft={draft} setDraft={setDraft} />
              <EditLine label="Holiday" field="holiday_pay" draft={draft} setDraft={setDraft} />
              <EditLine label="Others less" field="others_less" draft={draft} setDraft={setDraft} negative />
              <EditLine
                label="Adjustment less"
                field="adjustment_less"
                draft={draft}
                setDraft={setDraft}
                negative
                hint={row.late_charge != null ? `computed late/undertime ₱${peso(Number(row.late_charge))}` : undefined}
              />
              <tr className="border-t-2 border-ink/20">
                <td className="py-2 font-bold text-ink">TOTAL</td>
                <td />
                <td className="py-2 text-right font-bold tabular-nums text-ink">₱{peso(totals.subtotal)}</td>
              </tr>
              <EditLine label="Cash advance" field="cash_advance" draft={draft} setDraft={setDraft} negative />
              <EditLine label="SSS" field="sss" draft={draft} setDraft={setDraft} negative />
              <EditLine label="PhilHealth" field="philhealth" draft={draft} setDraft={setDraft} negative />
              <EditLine label="Pag-IBIG" field="pagibig" draft={draft} setDraft={setDraft} negative />
              <EditLine label="Others" field="others" draft={draft} setDraft={setDraft} negative />
              <tr className="border-t-2 border-ink/20">
                <td className="py-3 text-base font-bold text-ink">NET PAY</td>
                <td />
                <td className="py-3 text-right text-base font-bold tabular-nums text-ink">₱{peso(totals.net)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Line({ label, remark, value, strong }: { label: string; remark?: string; value: number; strong?: boolean }) {
  return (
    <tr className="border-t border-line">
      <td className={`py-1.5 ${strong ? 'font-semibold text-ink' : 'text-ink'}`}>{label}</td>
      <td className="py-1.5 text-xs text-muted">{remark}</td>
      <td className="py-1.5 text-right tabular-nums text-ink">₱{peso(value)}</td>
    </tr>
  );
}

function EditLine({
  label,
  field,
  draft,
  setDraft,
  negative,
  hint,
}: {
  label: string;
  field: keyof PayslipManualAmounts;
  draft: PayslipManualAmounts;
  setDraft: (d: PayslipManualAmounts) => void;
  negative?: boolean;
  hint?: string;
}) {
  const v = draft[field];
  return (
    <tr className="border-t border-line">
      <td className="py-1.5 text-ink">{label}</td>
      <td className="py-1.5 text-xs text-muted">{hint}</td>
      <td className="py-1.5 text-right">
        {/* Printed slips show the number; on screen it stays editable. */}
        <span className="hidden tabular-nums print:inline">
          {negative && v > 0 ? '−' : ''}₱{peso(v)}
        </span>
        <input
          type="number"
          min={0}
          step="0.01"
          value={v === 0 ? '' : v}
          placeholder="0.00"
          onChange={(e) => setDraft({ ...draft, [field]: Math.max(0, Number(e.target.value) || 0) })}
          className={`input w-32 text-right tabular-nums print:hidden ${negative && v > 0 ? 'text-red-600' : ''}`}
        />
      </td>
    </tr>
  );
}
