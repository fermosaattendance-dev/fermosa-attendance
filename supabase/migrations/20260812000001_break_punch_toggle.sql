-- Break-punch on/off toggle (2026-07-22).
--
-- Breaks were removed from the time clock earlier via the compile-time constant
-- BREAKS_ENABLED = false (packages/shared/src/constants.ts), which hides the
-- Start Break / End Break buttons while the engine still auto-deducts the
-- minimum break (min_break_min) on days over 5 h. This adds a single
-- company-wide switch so admins can turn break punching back on (or off) from
-- Settings without a deploy.
--
-- Default false preserves today's behavior (breaks hidden) on every existing
-- row; admins flip it on from Settings when staff should punch their own breaks.
--
-- Read by any company member (attendance_settings_select), writable by admins
-- only (attendance_settings_write) — the existing policies on the table cover
-- this column, so no RLS change is needed. No engine/function change: the flag
-- is read by the client only. When breaks are punched, the existing
-- app.compute_attendance_record already computes break_minutes from the matched
-- break pairs and uses max(punched, min_break) on long days.

alter table public.attendance_settings
  add column if not exists break_punch_enabled boolean not null default false;
