import type { LeaveStatus, LiveStatus, PunchType, Role } from './types';

export const DEFAULT_TIMEZONE = 'Asia/Manila';

/** Payroll periods are semi-monthly (1–15, 16–EOM) — Philippine "kinsenas". */
export const PAY_PERIOD_MODEL = 'semi_monthly' as const;

export const DEFAULT_GEOFENCE_RADIUS_M = 100;

/**
 * Internal domain for username-based login. Employees sign in with a plain
 * username; Supabase Auth (which is email-based) stores `<username>@<this>`.
 * Never shown to users. See usernameToEmail().
 */
export const USERNAME_EMAIL_DOMAIN = 'fermosa.local';

/**
 * Roles allowed to approve/reject/correct attendance.
 * Product decision (2026-07-14): branch managers are VIEW-ONLY on reviews;
 * approval centralizes with HR / operations / super admin.
 */
export const REVIEWER_ROLES: Role[] = ['hr', 'operations_manager', 'super_admin'];

/** Punch types that require a selfie (product decision: in/out only, breaks stay fast). */
export const SELFIE_PUNCH_TYPES: PunchType[] = ['clock_in', 'clock_out'];

/**
 * Break punches are hidden for now (product decision 2026-07-16): staff only
 * Time In / Time Out, and the engine automatically deducts the company's
 * minimum break (60 min) on days spanning more than 5 hours. Flip to true to
 * bring the break buttons back everywhere.
 */
export const BREAKS_ENABLED = false;

/** Roles with company-wide visibility (vs. own-branch or own-records). */
export const COMPANY_WIDE_ROLES: Role[] = ['hr', 'operations_manager', 'super_admin'];

/** Punch uploads whose device-vs-server time gap exceeds this are flagged for HR review. */
export const CLOCK_DRIFT_FLAG_THRESHOLD_MIN = 24 * 60; // offline punches can legitimately sync a day late

export const LEAVE_STATUS_LABELS: Record<LeaveStatus, string> = {
  pending: 'Pending',
  approved: 'Approved',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
};

export const LIVE_STATUS_LABELS: Record<LiveStatus, string> = {
  working: 'Working',
  on_break: 'On break',
  clocked_out: 'Done',
  not_in: 'Not in',
};

/**
 * Friendly labels for audit_logs.action values. Unknown actions fall back to
 * the raw string in the UI, so this map need not be exhaustive.
 */
export const AUDIT_ACTION_LABELS: Record<string, string> = {
  employee_created: 'Employee created',
  password_reset: 'Password reset',
  pin_set: 'PIN set',
  profile_updated: 'Profile updated',
  attendance_reviewed: 'Attendance reviewed',
  attendance_day_created: 'Attendance day created',
  leave_reviewed: 'Leave reviewed',
  mfa_enrolled: '2FA enabled',
  mfa_disabled: '2FA disabled',
  mfa_reset: '2FA reset (admin)',
  compensation_set: 'Compensation set',
};

export const ROLE_LABELS: Record<Role, string> = {
  employee: 'Employee',
  branch_manager: 'Branch Manager',
  hr: 'HR',
  operations_manager: 'Operations Manager',
  super_admin: 'Super Admin',
};
