import { describe, expect, it } from 'vitest';
import { countLeaveDays, isLeaveEligible } from './leave';

// Mon-Sat branch (matches Fermosa's default work_days {1,2,3,4,5,6}).
const MON_SAT = [1, 2, 3, 4, 5, 6];

describe('countLeaveDays', () => {
  it('counts a full working-week Mon–Fri as 5', () => {
    expect(countLeaveDays('2026-07-13', '2026-07-17', MON_SAT)).toBe(5);
  });

  it('skips the Sunday rest day', () => {
    // Sat 07-11, Sun 07-12 (rest), Mon 07-13 → 2
    expect(countLeaveDays('2026-07-11', '2026-07-13', MON_SAT)).toBe(2);
  });

  it('skips holidays inside the range', () => {
    // Thu 06-11, Fri 06-12 (Independence Day), Sat 06-13 → 2
    expect(countLeaveDays('2026-06-11', '2026-06-13', MON_SAT, ['2026-06-12'])).toBe(2);
  });

  it('returns 0.5 for a half-day regardless of range', () => {
    expect(countLeaveDays('2026-07-13', '2026-07-13', MON_SAT, [], true)).toBe(0.5);
  });

  it('counts a single working day as 1', () => {
    expect(countLeaveDays('2026-07-13', '2026-07-13', MON_SAT)).toBe(1);
  });

  it('is 0 when the only day is a rest day', () => {
    expect(countLeaveDays('2026-07-12', '2026-07-12', MON_SAT)).toBe(0);
  });

  it('returns 0 for an inverted range', () => {
    expect(countLeaveDays('2026-07-17', '2026-07-13', MON_SAT)).toBe(0);
  });

  it('respects a Mon–Fri branch (Sat also off)', () => {
    // Fri 07-17, Sat 07-18 (off), Sun 07-19 (off), Mon 07-20 → 2
    expect(countLeaveDays('2026-07-17', '2026-07-20', [1, 2, 3, 4, 5])).toBe(2);
  });
});

describe('isLeaveEligible', () => {
  it('is true only for regular (active) employees', () => {
    expect(isLeaveEligible('active')).toBe(true);
  });

  it('is false for probationary and other non-active statuses', () => {
    expect(isLeaveEligible('probationary')).toBe(false);
    expect(isLeaveEligible('on_leave')).toBe(false);
    expect(isLeaveEligible('resigned')).toBe(false);
    expect(isLeaveEligible('terminated')).toBe(false);
  });
});
