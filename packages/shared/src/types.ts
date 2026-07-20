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
  /** Null = roving employee (no home branch) who hasn't punched yet today. */
  branch_id: string | null;
  branch_name: string | null;
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
  birthday_only: boolean; // true = usable only within the employee's birth month (Birthday Leave)
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

/** One row of public.report_payroll_summary — an employee's period totals. */
export interface PayrollSummaryRow {
  employee_id: string;
  employee_code: string;
  full_name: string;
  branch_id: string;
  branch_name: string;
  scheduled_days: number; // days with a daily record in the period
  days_present: number;
  days_absent: number;
  worked_minutes: number;
  late_minutes: number;
  undertime_minutes: number;
  overtime_minutes: number;
  paid_leave_days: number;
  unpaid_leave_days: number;
  rest_days_worked: number;
  holidays_worked: number;
  full_days: number; // days present that were NOT half-day-late (allowance = full_days × daily_allowance)
  daily_rate: number | null; // null: no compensation set, or the caller may not see it
  daily_allowance: number | null;
  late_charge: number | null; // (late + undertime minutes) × daily_rate/480, all days
  ot_paid_hours: number; // whole OT hours, floored per day (not rate-derived)
  ot_pay: number | null; // ot_paid_hours × daily_rate × 1.25/8; null when rate hidden
}

/**
 * One row of public.payroll_adjustments — the manual amounts HR sets per
 * employee per pay period (uploaded in bulk from a spreadsheet, or edited on a
 * single payslip). Admin-only: RLS returns nothing to branch managers.
 */
export interface PayrollAdjustments {
  employee_id: string;
  period_start: string;
  period_end: string;
  add_allowance: number;
  holiday_pay: number;
  others_less: number;
  adjustment_less: number;
  cash_advance: number;
  sss: number;
  philhealth: number;
  pagibig: number;
  others: number;
  note: string | null;
  updated_at: string;
}

/** Status of a payroll → Google Sheets push. */
export type PayrollSyncStatus = 'synced' | 'dry_run' | 'failed';

/** One row of public.payroll_syncs — the log of Google Sheets pushes. */
export interface PayrollSyncLog {
  id: string;
  company_id: string;
  period_start: string; // 'YYYY-MM-DD'
  period_end: string;
  branch_id: string | null; // null = all branches
  sheet_id: string | null;
  sheet_tab: string;
  row_count: number;
  checksum: string | null;
  status: PayrollSyncStatus;
  error: string | null;
  synced_by: string | null;
  synced_at: string;
}

/** One row of public.audit_log_view — an audit event with the actor's name/role. */
export interface AuditLogRow {
  id: number;
  company_id: string;
  actor_id: string | null;
  actor_name: string | null;
  actor_role: Role | null;
  action: string;
  table_name: string;
  record_id: string | null;
  details: Record<string, unknown> | null;
  created_at: string;
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
  /** Branch Shift 1 (the default). */
  shift_start: string; // 'HH:MM:SS'
  shift_end: string;
  /** Optional Shift 2 — when set, the branch runs two shifts and staff pick
   *  which one they are timing in for. Null = single-shift branch. */
  shift2_start: string | null;
  shift2_end: string | null;
  /** Optional Shift 3 (e.g. opening / mid / closing). Requires Shift 2.
   *  Null = branch has no 3rd shift. */
  shift3_start: string | null;
  shift3_end: string | null;
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
  | 'on_leave'
  | 'half_day' // late >= attendance_settings.half_day_late_min — counts 0.5 in payroll
  | 'time_mismatch'; // device time vs server receive time gap > 10 min

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
  date_hired: string | null; // 'YYYY-MM-DD'
  birthday: string | null; // 'YYYY-MM-DD'
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
  /** Shift the employee picked for this punch (null = branch Shift 1). */
  shift_start: string | null;
  shift_end: string | null;
}

/** Payload for the `admin-users` Edge Function: create an employee account. */
export interface CreateEmployeeInput {
  email: string; // login identifier — a plain username or a real email; the function maps it via usernameToEmail()
  password: string; // temp password set by HR, communicated out-of-band
  full_name: string;
  employee_code: string;
  role: Role;
  branch_id: string | null;
  department_id: string | null;
  position_id: string | null;
  employment_status: EmploymentStatus;
  phone: string | null;
  date_hired?: string | null; // 'YYYY-MM-DD'
  birthday?: string | null; // 'YYYY-MM-DD'
}

export type AdminUsersRequest =
  | { action: 'create'; input: CreateEmployeeInput }
  | { action: 'reset_password'; user_id: string; new_password: string }
  | { action: 'mfa_reset'; user_id: string };

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
  /** Null only transiently for a roving employee's queue row (both queues store it per punch). */
  branch_id: string | null;
  /** Shift picked at time-in for a 2-shift branch (null = branch Shift 1). */
  shift_start?: string | null;
  shift_end?: string | null;
  sync_status: 'pending_sync' | 'syncing' | 'synced' | 'failed';
  attempts: number;
}
