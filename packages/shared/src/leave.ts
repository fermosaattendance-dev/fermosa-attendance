/**
 * Leave day counting, mirroring the SQL app.leave_day_count
 * (migration 20260719000001_leave.sql). Whole-day leave counts only the
 * employee's branch working days that aren't holidays; a half-day is 0.5.
 * Used for a live preview in the mobile request form — the server value
 * (trigger-computed) stays authoritative.
 */

import type { EmploymentStatus } from './types';

/**
 * Leave (entitlements + the "My leave" UI) is for REGULAR employees only —
 * employment_status 'active'. Mirrors the grant_leave_entitlements SQL gate,
 * so probationary and other non-active staff see no leave anywhere.
 */
export function isLeaveEligible(status: EmploymentStatus): boolean {
  return status === 'active';
}

/** ISO date string 'YYYY-MM-DD' → ISO weekday 1 (Mon) … 7 (Sun). */
function isoWeekday(date: string): number {
  // Parse as UTC noon to avoid any timezone/DST edge on the date boundary.
  const d = new Date(`${date}T12:00:00Z`);
  const js = d.getUTCDay(); // 0 (Sun) … 6 (Sat)
  return js === 0 ? 7 : js;
}

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Working days in [start, end] given the branch work days and holiday dates.
 * @param workDays ISO weekday numbers the branch operates (1=Mon … 7=Sun).
 * @param holidayDates 'YYYY-MM-DD' strings to exclude.
 * @param halfDay when true, returns 0.5 (caller enforces single-day).
 */
export function countLeaveDays(
  startDate: string,
  endDate: string,
  workDays: number[],
  holidayDates: string[] = [],
  halfDay = false,
): number {
  if (halfDay) return 0.5;
  if (endDate < startDate) return 0;
  const holidays = new Set(holidayDates);
  let count = 0;
  for (let d = startDate; d <= endDate; d = addDays(d, 1)) {
    if (workDays.includes(isoWeekday(d)) && !holidays.has(d)) count += 1;
  }
  return count;
}
