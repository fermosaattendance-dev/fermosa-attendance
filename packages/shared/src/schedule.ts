/**
 * Branch work-day math, mirroring the SQL in app.work_day_cutoff /
 * app.punch_work_date (migration 20260718000001_overnight_shifts.sql).
 * A punch belongs to work date D when its branch-local time falls in
 * [D + cutoff, D+1 + cutoff), where cutoff is the midpoint of the off-duty
 * gap between shift end and the next shift start. Overnight shifts are
 * signaled by shift_end <= shift_start and end on D+1.
 */

const MINUTES_PER_DAY = 24 * 60;

/** Parse Postgres time ("HH:MM" or "HH:MM:SS") to minutes since midnight. */
function toMinutes(time: string): number {
  const [h = 0, m = 0] = time.split(':').map(Number);
  return h * 60 + m;
}

export function isOvernight(shiftStart: string, shiftEnd: string): boolean {
  return toMinutes(shiftEnd) <= toMinutes(shiftStart);
}

/** Cutoff as minutes since midnight — same integer math as the SQL. */
export function workDayCutoffMinutes(shiftStart: string, shiftEnd: string): number {
  const start = toMinutes(shiftStart);
  const end = toMinutes(shiftEnd);
  const length = end > start ? end - start : MINUTES_PER_DAY - (start - end);
  return (end + Math.floor((MINUTES_PER_DAY - length) / 2)) % MINUTES_PER_DAY;
}

/**
 * UTC window containing every punch of the given work date.
 * tzOffsetHours defaults to Asia/Manila (UTC+8, no DST).
 */
export function punchWindowForWorkDate(
  workDate: string,
  shiftStart: string,
  shiftEnd: string,
  tzOffsetHours = 8,
): { startIso: string; endIso: string } {
  const cutoffMin = workDayCutoffMinutes(shiftStart, shiftEnd);
  const localMidnightUtcMs = Date.parse(`${workDate}T00:00:00Z`) - tzOffsetHours * 3_600_000;
  const startMs = localMidnightUtcMs + cutoffMin * 60_000;
  return {
    startIso: new Date(startMs).toISOString(),
    endIso: new Date(startMs + MINUTES_PER_DAY * 60_000).toISOString(),
  };
}

function to12Hour(time: string): string {
  const min = toMinutes(time);
  const h24 = Math.floor(min / 60);
  const m = min % 60;
  const suffix = h24 < 12 ? 'AM' : 'PM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${suffix}`;
}

/** e.g. "10:00 AM – 7:00 PM", or "10:00 PM – 6:00 AM +1" for overnight. */
export function formatShift(shiftStart: string, shiftEnd: string): string {
  const base = `${to12Hour(shiftStart)} – ${to12Hour(shiftEnd)}`;
  return isOvernight(shiftStart, shiftEnd) ? `${base} +1` : base;
}

export interface ShiftOption {
  start: string; // 'HH:MM' or 'HH:MM:SS'
  end: string;
  label: string; // e.g. "9:00 AM – 6:00 PM"
}

/**
 * The 1–2 selectable shifts for a branch. Shift 2 is included only when the
 * branch defines it — that's the signal to show a shift picker at time-in.
 */
export function branchShifts(b: {
  shift_start: string;
  shift_end: string;
  shift2_start?: string | null;
  shift2_end?: string | null;
}): ShiftOption[] {
  const out: ShiftOption[] = [
    { start: b.shift_start, end: b.shift_end, label: formatShift(b.shift_start, b.shift_end) },
  ];
  if (b.shift2_start && b.shift2_end) {
    out.push({ start: b.shift2_start, end: b.shift2_end, label: formatShift(b.shift2_start, b.shift2_end) });
  }
  return out;
}
