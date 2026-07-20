import { computePayslip, formatPeriodLabel, payPeriodFor, type MyPayslipRow } from '@fermosa/shared';
import { useCallback, useEffect, useState } from 'react';
import { PageHeader } from '../components/PageHeader';
import { PayslipView } from '../components/PayslipView';
import { useAuth } from '../lib/auth';
import { supabase } from '../lib/supabase';

interface PeriodRow {
  period_start: string;
  period_end: string;
  published_at: string;
}

/**
 * The employee's own payslip. Everything comes from the my_payslip() RPC, which
 * returns nothing until HR deploys that cutoff — the release gate lives in the
 * database, not here.
 */
export function MyPayslip() {
  const { profile } = useAuth();
  const [periods, setPeriods] = useState<PeriodRow[] | null>(null);
  const [selected, setSelected] = useState<string>('');
  const [slip, setSlip] = useState<MyPayslipRow | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    supabase.rpc('my_payslip_periods').then(({ data }) => {
      const rows = (data as PeriodRow[]) ?? [];
      setPeriods(rows);
      if (rows.length > 0) setSelected(rows[0]!.period_start);
    });
  }, []);

  const load = useCallback(() => {
    if (!selected) {
      setSlip(null);
      return;
    }
    setLoading(true);
    supabase.rpc('my_payslip', { p_period_start: selected }).then(({ data }) => {
      const rows = (data as MyPayslipRow[]) ?? [];
      setSlip(rows[0] ?? null);
      setLoading(false);
    });
  }, [selected]);

  useEffect(() => {
    load();
  }, [load]);

  if (!profile) return null;

  const labelFor = (p: PeriodRow) => formatPeriodLabel(payPeriodFor(`${p.period_start}T00:00:00Z`));

  const totals = slip
    ? computePayslip({
        daily_rate: Number(slip.daily_rate ?? 0),
        daily_allowance: Number(slip.daily_allowance ?? 0),
        days_present: slip.days_present,
        full_days: slip.full_days,
        paid_leave_days: slip.paid_leave_days,
        ot_pay: Number(slip.ot_pay ?? 0),
        add_allowance: Number(slip.add_allowance),
        holiday_pay: Number(slip.holiday_pay),
        others_less: Number(slip.others_less),
        adjustment_less: Number(slip.adjustment_less),
        cash_advance: Number(slip.cash_advance),
        sss: Number(slip.sss),
        philhealth: Number(slip.philhealth),
        pagibig: Number(slip.pagibig),
        others: Number(slip.others),
      })
    : null;

  return (
    <div className="mx-auto max-w-2xl">
      <div className="no-print">
        <PageHeader title="My payslip" crumb="My payslip" subtitle="Released by HR after each cutoff." />

        {periods && periods.length > 0 && (
          <div className="flex flex-wrap items-end gap-3 card p-4">
            <label className="flex-1 text-sm">
              <span className="block text-xs font-medium text-gray-500">Pay period</span>
              <select
                value={selected}
                onChange={(e) => setSelected(e.target.value)}
                className="mt-1 input w-full"
              >
                {periods.map((p) => (
                  <option key={p.period_start} value={p.period_start}>
                    {labelFor(p)}
                  </option>
                ))}
              </select>
            </label>
            {slip && (
              <button onClick={() => window.print()} className="btn">
                Print
              </button>
            )}
          </div>
        )}

        {periods && periods.length === 0 && (
          <div className="card p-6 text-sm text-muted">
            No payslip has been released yet — HR publishes it after each cutoff.
          </div>
        )}

        {loading && <p className="mt-3 text-sm text-muted">Loading…</p>}
        {!loading && selected && !slip && periods && periods.length > 0 && (
          <p className="mt-3 rounded-xl bg-ground px-4 py-3 text-sm text-muted">
            No payslip for this period — you may have had no approved attendance in it.
          </p>
        )}
      </div>

      {slip && totals && (
        <div className="mt-4">
          <PayslipView
            employeeName={slip.full_name}
            employeeCode={slip.employee_code}
            branchName={slip.branch_name}
            dateHired={slip.date_hired}
            leaveRemaining={Number(slip.leave_remaining)}
            dailyRate={slip.daily_rate}
            dailyAllowance={slip.daily_allowance}
            periodLabel={formatPeriodLabel(payPeriodFor(`${slip.period_start}T00:00:00Z`))}
            periodStart={slip.period_start}
            periodEnd={slip.period_end}
            daysPresent={slip.days_present}
            fullDays={slip.full_days}
            paidLeaveDays={slip.paid_leave_days}
            otPaidHours={slip.ot_paid_hours}
            amounts={{
              add_allowance: Number(slip.add_allowance),
              holiday_pay: Number(slip.holiday_pay),
              others_less: Number(slip.others_less),
              adjustment_less: Number(slip.adjustment_less),
              cash_advance: Number(slip.cash_advance),
              sss: Number(slip.sss),
              philhealth: Number(slip.philhealth),
              pagibig: Number(slip.pagibig),
              others: Number(slip.others),
            }}
            totals={totals}
          />
        </div>
      )}
    </div>
  );
}
