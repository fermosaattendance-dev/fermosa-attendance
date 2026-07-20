/**
 * Payslip arithmetic — the single source of truth so the on-screen slip, the
 * printed slip and any future export can never disagree.
 *
 * Rules (owner decisions 2026-07-20):
 *  - basic      = daily rate × days present (a half-day counts 0.5)
 *  - allowance  = daily allowance × FULL days only (a half-day earns none)
 *  - paid leave = paid leave days × daily rate
 *  - overtime   = the engine's computed OT pay (whole OT hours × rate/8 × 125%)
 *  - "adjustment less" is FULLY MANUAL — the computed late/undertime charge is
 *    shown beside it for reference but never auto-applied.
 *
 * Verified against the owner's real payslip; see payslip.test.ts.
 */

/** The nine amounts HR sets per employee per pay period (uploaded or typed). */
export interface PayslipManualAmounts {
  add_allowance: number;
  holiday_pay: number;
  others_less: number;
  adjustment_less: number;
  cash_advance: number;
  sss: number;
  philhealth: number;
  pagibig: number;
  others: number;
}

/** Everything needed to compute one payslip. */
export interface PayslipInput extends PayslipManualAmounts {
  daily_rate: number;
  daily_allowance: number;
  days_present: number;
  full_days: number;
  paid_leave_days: number;
  ot_pay: number;
}

export interface PayslipTotals {
  basic: number;
  allowance: number;
  paid_leave: number;
  overtime: number;
  additions: number;
  /** Pay less the pre-subtotal deductions (others less + adjustment less). */
  subtotal: number;
  /** cash advance + SSS + PhilHealth + Pag-IBIG + others. */
  deductions: number;
  net: number;
}

/** Round to 2 decimals without float dust (0.1 + 0.2 style). */
function money(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Empty set of manual amounts — the default when HR hasn't filled a period. */
export const EMPTY_MANUAL_AMOUNTS: PayslipManualAmounts = {
  add_allowance: 0,
  holiday_pay: 0,
  others_less: 0,
  adjustment_less: 0,
  cash_advance: 0,
  sss: 0,
  philhealth: 0,
  pagibig: 0,
  others: 0,
};

export function computePayslip(i: PayslipInput): PayslipTotals {
  const basic = money(i.daily_rate * i.days_present);
  const allowance = money(i.daily_allowance * i.full_days);
  const paid_leave = money(i.daily_rate * i.paid_leave_days);
  const overtime = money(i.ot_pay);

  const additions = money(
    basic + allowance + paid_leave + overtime + i.add_allowance + i.holiday_pay,
  );
  const subtotal = money(additions - i.others_less - i.adjustment_less);
  const deductions = money(i.cash_advance + i.sss + i.philhealth + i.pagibig + i.others);
  const net = money(subtotal - deductions);

  return { basic, allowance, paid_leave, overtime, additions, subtotal, deductions, net };
}
