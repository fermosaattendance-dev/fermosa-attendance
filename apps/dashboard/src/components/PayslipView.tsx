import type { PayslipManualAmounts, PayslipTotals } from '@fermosa/shared';

/**
 * The payslip document itself — rendered identically for HR (editable amounts)
 * and for the employee (read-only), so the two can never show different slips.
 * Printing is handled by the `#payslip` id + the @media print rules in index.css.
 */

const peso = (n: number) =>
  n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const dateFmt = new Intl.DateTimeFormat('en-PH', { month: 'long', day: 'numeric', year: 'numeric' });
const fmtDate = (d: string | null) => (d ? dateFmt.format(new Date(`${d}T00:00:00`)) : '—');

export interface PayslipViewProps {
  employeeName: string;
  employeeCode: string;
  branchName?: string | null;
  dateHired: string | null;
  leaveRemaining: number;
  dailyRate: number | null;
  dailyAllowance: number | null;
  periodLabel: string;
  periodStart: string;
  periodEnd: string;
  daysPresent: number;
  fullDays: number;
  paidLeaveDays: number;
  otPaidHours: number;
  amounts: PayslipManualAmounts;
  totals: PayslipTotals;
  /** Provide to make the nine amounts editable (HR). Omit for a read-only slip. */
  onChange?: (next: PayslipManualAmounts) => void;
  /** Reference figure shown beside "Adjustment less" (HR only). */
  lateChargeHint?: number | null;
}

export function PayslipView(p: PayslipViewProps) {
  const editable = typeof p.onChange === 'function';

  return (
    <div id="payslip" className="card p-6">
      {/* Branding — centred, and kept when printing. */}
      <div className="mb-4 flex flex-col items-center border-b border-line pb-4">
        <img
          src="/fermosa-wordmark.jpg"
          alt="Fermosa Skin Care Clinic"
          className="h-12 w-auto object-contain"
        />
        <p className="mt-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-muted">
          Payslip
        </p>
      </div>

      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line pb-3">
        <div>
          <h2 className="text-lg font-bold text-ink">{p.employeeName}</h2>
          <p className="text-xs text-muted">
            {p.employeeCode}
            {p.branchName ? ` · ${p.branchName}` : ''}
          </p>
        </div>
        <div className="text-right text-xs text-muted">
          <div className="font-semibold text-ink">{p.periodLabel}</div>
          <div>
            {fmtDate(p.periodStart)} – {fmtDate(p.periodEnd)}
          </div>
        </div>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-xs text-muted">Employment date</dt>
          <dd className="font-medium text-ink">{fmtDate(p.dateHired)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Leave remaining</dt>
          <dd className="font-medium text-ink">{p.leaveRemaining}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Daily rate</dt>
          <dd className="font-medium text-ink">₱{peso(Number(p.dailyRate ?? 0))}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Allowance / full day</dt>
          <dd className="font-medium text-ink">₱{peso(Number(p.dailyAllowance ?? 0))}</dd>
        </div>
      </dl>

      {p.dailyRate === null && (
        <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
          No daily rate set for this employee — set it on their profile first.
        </p>
      )}

      <table className="mt-4 w-full text-sm">
        <tbody>
          <Line label={p.periodLabel} remark={`${p.daysPresent} days present`} value={p.totals.basic} strong />
          <Line label="Allowance" remark={`${p.fullDays} full days`} value={p.totals.allowance} />
          {p.totals.paid_leave > 0 && (
            <Line label="Paid leave" remark={`${p.paidLeaveDays} days`} value={p.totals.paid_leave} />
          )}
          {p.totals.overtime > 0 && (
            <Line label="Overtime" remark={`${p.otPaidHours} hrs`} value={p.totals.overtime} />
          )}
          <Amount label="Add allowance" field="add_allowance" {...p} editable={editable} />
          <Amount label="Holiday" field="holiday_pay" {...p} editable={editable} />
          <Amount label="Others less" field="others_less" {...p} editable={editable} negative />
          <Amount
            label="Adjustment less"
            field="adjustment_less"
            {...p}
            editable={editable}
            negative
            hint={
              editable && p.lateChargeHint != null
                ? `computed late/undertime ₱${peso(Number(p.lateChargeHint))}`
                : undefined
            }
          />
          <tr className="border-t-2 border-ink/20">
            <td className="py-2 font-bold text-ink">TOTAL</td>
            <td />
            <td className="py-2 text-right font-bold tabular-nums text-ink">₱{peso(p.totals.subtotal)}</td>
          </tr>
          <Amount label="Cash advance" field="cash_advance" {...p} editable={editable} negative />
          <Amount label="SSS" field="sss" {...p} editable={editable} negative />
          <Amount label="PhilHealth" field="philhealth" {...p} editable={editable} negative />
          <Amount label="Pag-IBIG" field="pagibig" {...p} editable={editable} negative />
          <Amount label="Others" field="others" {...p} editable={editable} negative />
          <tr className="border-t-2 border-ink/20">
            <td className="py-3 text-base font-bold text-ink">NET PAY</td>
            <td />
            <td className="py-3 text-right text-base font-bold tabular-nums text-ink">
              ₱{peso(p.totals.net)}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function Line({
  label,
  remark,
  value,
  strong,
}: {
  label: string;
  remark?: string;
  value: number;
  strong?: boolean;
}) {
  return (
    <tr className="border-t border-line">
      <td className={`py-1.5 ${strong ? 'font-semibold text-ink' : 'text-ink'}`}>{label}</td>
      <td className="py-1.5 text-xs text-muted">{remark}</td>
      <td className="py-1.5 text-right tabular-nums text-ink">₱{peso(value)}</td>
    </tr>
  );
}

function Amount({
  label,
  field,
  amounts,
  onChange,
  editable,
  negative,
  hint,
}: PayslipViewProps & {
  label: string;
  field: keyof PayslipManualAmounts;
  editable: boolean;
  negative?: boolean;
  hint?: string;
}) {
  const v = amounts[field];
  return (
    <tr className="border-t border-line">
      <td className="py-1.5 text-ink">{label}</td>
      <td className="py-1.5 text-xs text-muted">{hint}</td>
      <td className="py-1.5 text-right">
        {editable ? (
          <>
            {/* Printed slips show the figure; on screen HR keeps an input. */}
            <span className="hidden tabular-nums print:inline">
              {negative && v > 0 ? '−' : ''}₱{peso(v)}
            </span>
            <input
              type="number"
              min={0}
              step="0.01"
              value={v === 0 ? '' : v}
              placeholder="0.00"
              onChange={(e) =>
                onChange?.({ ...amounts, [field]: Math.max(0, Number(e.target.value) || 0) })
              }
              className={`input w-32 text-right tabular-nums print:hidden ${
                negative && v > 0 ? 'text-red-600' : ''
              }`}
            />
          </>
        ) : (
          <span className={`tabular-nums ${negative && v > 0 ? 'text-red-600' : 'text-ink'}`}>
            {negative && v > 0 ? '−' : ''}₱{peso(v)}
          </span>
        )}
      </td>
    </tr>
  );
}
