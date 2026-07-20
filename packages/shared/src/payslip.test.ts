import { describe, expect, it } from 'vitest';
import { EMPTY_MANUAL_AMOUNTS, computePayslip, type PayslipInput } from './payslip';

const base: PayslipInput = {
  daily_rate: 0,
  daily_allowance: 0,
  days_present: 0,
  full_days: 0,
  paid_leave_days: 0,
  ot_pay: 0,
  ...EMPTY_MANUAL_AMOUNTS,
};

describe('computePayslip', () => {
  /**
   * The owner's real payslip (Montinola, July 1–15 2026): ₱600/day, 10.5 days
   * present, 10 full days, ₱250/day allowance, +50 add allowance, −16.25
   * adjustment, −650 SSS. Their sheet shows sub-total 8,833.75 and net
   * 8,183.75 — this test locks our arithmetic to that.
   */
  it('reproduces the real July 1-15 payslip', () => {
    const t = computePayslip({
      ...base,
      daily_rate: 600,
      daily_allowance: 250,
      days_present: 10.5,
      full_days: 10,
      add_allowance: 50,
      adjustment_less: 16.25,
      sss: 650,
    });
    expect(t.basic).toBe(6300); // 600 × 10.5
    expect(t.allowance).toBe(2500); // 250 × 10 full days
    expect(t.additions).toBe(8850); // 6300 + 2500 + 50
    expect(t.subtotal).toBe(8833.75);
    expect(t.deductions).toBe(650);
    expect(t.net).toBe(8183.75);
  });

  it('pays the half-day in basic but not in allowance', () => {
    const t = computePayslip({
      ...base,
      daily_rate: 600,
      daily_allowance: 250,
      days_present: 9.5, // one day was a half-day
      full_days: 9,
    });
    expect(t.basic).toBe(5700); // 600 × 9.5 — the half day is still paid
    expect(t.allowance).toBe(2250); // 250 × 9 — the half day earns no allowance
  });

  it('adds paid leave and overtime as their own lines', () => {
    const t = computePayslip({
      ...base,
      daily_rate: 600,
      days_present: 10,
      full_days: 10,
      paid_leave_days: 1.5,
      ot_pay: 93.75, // 1 OT hour at 600/8 × 1.25
    });
    expect(t.paid_leave).toBe(900); // 600 × 1.5
    expect(t.overtime).toBe(93.75);
    expect(t.additions).toBe(6993.75); // 6000 + 900 + 93.75
  });

  it('takes others/adjustment before the sub-total and the rest after', () => {
    const t = computePayslip({
      ...base,
      daily_rate: 1000,
      days_present: 10,
      others_less: 100,
      adjustment_less: 50,
      cash_advance: 500,
      sss: 650,
      philhealth: 200,
      pagibig: 100,
      others: 25,
    });
    expect(t.additions).toBe(10000);
    expect(t.subtotal).toBe(9850); // 10000 − 100 − 50
    expect(t.deductions).toBe(1475); // 500 + 650 + 200 + 100 + 25
    expect(t.net).toBe(8375);
  });

  it('rounds money to 2 decimals without float dust', () => {
    const t = computePayslip({ ...base, daily_rate: 566.67, days_present: 10.5 });
    expect(t.basic).toBe(5950.04); // 566.67 × 10.5 = 5950.035
    expect(t.net).toBe(5950.04);
  });

  it('is all zeros when nothing is set', () => {
    const t = computePayslip(base);
    expect(t).toEqual({
      basic: 0,
      allowance: 0,
      paid_leave: 0,
      overtime: 0,
      additions: 0,
      subtotal: 0,
      deductions: 0,
      net: 0,
    });
  });
});
