import type { LeaveStatus, LiveStatus, PunchType, Role } from './types';

export const DEFAULT_TIMEZONE = 'Asia/Manila';

export const DEFAULT_GEOFENCE_RADIUS_M = 100;

/**
 * Roles allowed to approve/reject/correct attendance.
 * Product decision (2026-07-14): branch managers are VIEW-ONLY on reviews;
 * approval centralizes with HR / operations / super admin.
 */
export const REVIEWER_ROLES: Role[] = ['hr', 'operations_manager', 'super_admin'];

/** Punch types that require a selfie (product decision: in/out only, breaks stay fast). */
export const SELFIE_PUNCH_TYPES: PunchType[] = ['clock_in', 'clock_out'];

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

export const ROLE_LABELS: Record<Role, string> = {
  employee: 'Employee',
  branch_manager: 'Branch Manager',
  hr: 'HR',
  operations_manager: 'Operations Manager',
  super_admin: 'Super Admin',
};
