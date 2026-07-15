/**
 * Shared domain types. These mirror the Postgres schema in supabase/migrations
 * and are used by both the mobile app and the dashboard.
 */

export type Role =
  | 'employee'
  | 'branch_manager'
  | 'hr'
  | 'operations_manager'
  | 'super_admin';

export type EmploymentStatus = 'active' | 'probationary' | 'on_leave' | 'resigned' | 'terminated';

export type PunchType = 'clock_in' | 'break_start' | 'break_end' | 'clock_out';

export type PunchSource = 'mobile' | 'web' | 'kiosk';

/** Lifecycle of a daily attendance record. Only `approved` records reach payroll. */
export type AttendanceStatus = 'pending_review' | 'approved' | 'rejected' | 'corrected';

/** Informational flags computed by the attendance engine, independent of approval status. */
export type AttendanceFlag = 'on_time' | 'late' | 'early_out' | 'no_clock_out' | 'overtime';

/** Single-step approval (product decision 2026-07-15): HR+ approve directly. */
export type LeaveStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

/** An employee's live status right now, from their latest punch this work day. */
export type LiveStatus = 'working' | 'on_break' | 'clocked_out' | 'not_in';

/** A row of the dashboard_live() RPC — one active employee's current state. */
export interface LiveRosterRow {
  employee_id: string;
  full_name: string;
  employee_code: string;
  branch_id: string;
  branch_name: string;
  status: LiveStatus;
  scheduled: boolean;
  on_leave: boolean;
  overdue: boolean; // scheduled, no punch yet, past shift start + grace
  late_minutes: number;
  first_in: string | null;
  last_punch_at: string | null;
  work_date: string;
}

export interface LeaveType {
  id: string;
  company_id: string;
  name: string;
  is_paid: boolean;
  default_days_per_year: number;
  is_active: boolean;
}

export interface LeaveRequest {
  id: string;
  company_id: string;
  employee_id: string;
  leave_type_id: string;
  start_date: string; // 'YYYY-MM-DD'
  end_date: string;
  half_day: boolean;
  day_count: number; // working days in range (server-computed); 0.5 for half-day
  reason: string | null;
  status: LeaveStatus;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  created_at: string;
}

/** A row of public.leave_balances_view — entitlement plus computed usage. */
export interface LeaveBalance {
  id: string;
  company_id: string;
  employee_id: string;
  leave_type_id: string;
  year: number;
  entitled_days: number;
  used_days: number;
  remaining_days: number;
}

export interface Company {
  id: string;
  name: string;
  created_at: string;
}

export interface Branch {
  id: string;
  company_id: string;
  name: string;
  address: string | null;
  lat: number;
  lng: number;
  geofence_radius_m: number;
  timezone: string;
  is_active: boolean;
  /** Branch default schedule (per-employee shifts arrive with scheduling). */
  shift_start: string; // 'HH:MM:SS'
  shift_end: string;
  work_days: number[]; // ISO weekday numbers, 1 = Monday … 7 = Sunday
}

export type DayClass = 'regular' | 'rest_day' | 'regular_holiday' | 'special_holiday';

/** Engine flags on a daily record — separate from approval status. */
export type RecordFlag =
  | 'on_time'
  | 'late'
  | 'early_out'
  | 'no_clock_out'
  | 'overtime'
  | 'absent'
  | 'on_leave';

export interface Profile {
  id: string; // = auth.users.id
  company_id: string;
  branch_id: string | null;
  employee_code: string;
  full_name: string;
  role: Role;
  department_id: string | null;
  position_id: string | null;
  employment_status: EmploymentStatus;
  phone: string | null;
  photo_path: string | null;
  created_at: string;
}

export interface AttendanceEvent {
  id: string;
  client_uuid: string; // idempotency key generated on-device
  company_id: string;
  employee_id: string;
  branch_id: string;
  type: PunchType;
  source: PunchSource;
  happened_at: string; // device time — the official punch time
  received_at: string; // server ingest time
  lat: number | null;
  lng: number | null;
  gps_accuracy_m: number | null;
  inside_geofence: boolean | null; // recomputed server-side
  distance_from_branch_m: number | null;
  selfie_path: string | null;
  device_info: Record<string, unknown> | null;
}

/** Payload for the `admin-users` Edge Function: create an employee account. */
export interface CreateEmployeeInput {
  email: string;
  password: string; // temp password set by HR, communicated out-of-band
  full_name: string;
  employee_code: string;
  role: Role;
  branch_id: string | null;
  department_id: string | null;
  position_id: string | null;
  employment_status: EmploymentStatus;
  phone: string | null;
}

export type AdminUsersRequest =
  | { action: 'create'; input: CreateEmployeeInput }
  | { action: 'reset_password'; user_id: string; new_password: string };

export interface AdminUsersResponse {
  ok: boolean;
  user_id?: string;
  error?: string;
}

/** A punch queued on-device before it reaches the server. */
export interface QueuedPunch {
  client_uuid: string;
  type: PunchType;
  happened_at: string;
  lat: number | null;
  lng: number | null;
  gps_accuracy_m: number | null;
  selfie_local_uri: string | null;
  branch_id: string;
  sync_status: 'pending_sync' | 'syncing' | 'synced' | 'failed';
  attempts: number;
}
