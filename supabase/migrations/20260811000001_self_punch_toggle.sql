-- Employee self time in/out toggle (2026-07-21).
--
-- The clinic is moving personal punching onto shared branch kiosks. This adds a
-- single company-wide switch that hides the Time In / Time Out buttons on every
-- employee's My time clock (client-side only — the kiosk path is unaffected, and
-- leave/payslip/cutoff-summary stay available). Default true preserves today's
-- behavior on every existing row; admins flip it off from Settings when they cut
-- over to kiosks.
--
-- Read by any company member (attendance_settings_select), writable by admins
-- only (attendance_settings_write) — the existing policies on the table cover
-- this column, so no RLS change is needed. No engine/function change: the flag
-- is read by the client only and never touches payroll math.

alter table public.attendance_settings
  add column if not exists self_punch_enabled boolean not null default true;
