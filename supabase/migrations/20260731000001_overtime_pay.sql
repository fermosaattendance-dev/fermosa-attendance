-- Overtime pay (user decisions, 2026-07-17):
--   * OT pay per hour = daily_rate / 8 hrs × 125%.
--   * OT pays in WHOLE hours, floored PER DAY ("activated once every hour"):
--     90 min → 1 hr; two 90-min days → 2 hrs (not floor(180/60)=3).
--   * Flat 125% for every day (rest-day/holiday premiums deferred).
-- The engine already stores overtime_minutes = minutes past shift end (zeroed
-- when ≤ ot_threshold_min); no engine change. Rate lives in employee_compensation
-- (RLS keeps the peso amount admin-only). Report + Sheets sync only.

drop function public.report_payroll_summary(date, date, uuid);

create function public.report_payroll_summary(
  p_from date,
  p_to date,
  p_branch_id uuid default null
)
returns table (
  employee_id       uuid,
  employee_code     text,
  full_name         text,
  branch_id         uuid,
  branch_name       text,
  scheduled_days    int,
  days_present      double precision,
  days_absent       int,
  worked_minutes    int,
  late_minutes      int,
  undertime_minutes int,
  overtime_minutes  int,
  paid_leave_days   double precision,
  unpaid_leave_days double precision,
  rest_days_worked  int,
  holidays_worked   int,
  full_days         int,
  daily_rate        numeric,
  daily_allowance   numeric,
  late_charge       numeric,
  ot_paid_hours     int,
  ot_pay            numeric
)
language sql
stable
set search_path = public
as $$
  select
    p.id            as employee_id,
    p.employee_code,
    p.full_name,
    b.id            as branch_id,
    b.name          as branch_name,
    count(*)::int   as scheduled_days,
    coalesce(sum(case
      when eff.first_in is null then 0
      when coalesce(st.half_day_late_min, 60) > 0
           and eff.late_minutes >= greatest(coalesce(st.half_day_late_min, 60) - coalesce(st.late_grace_min, 15), 1)
        then 0.5
      else 1
    end), 0)::double precision                                    as days_present,
    count(*) filter (where 'absent' = any (eff.flags))::int       as days_absent,
    coalesce(sum(eff.worked_minutes), 0)::int                     as worked_minutes,
    coalesce(sum(eff.late_minutes), 0)::int                       as late_minutes,
    coalesce(sum(eff.undertime_minutes), 0)::int                  as undertime_minutes,
    coalesce(sum(eff.overtime_minutes), 0)::int                   as overtime_minutes,
    coalesce(sum(case when 'on_leave' = any (eff.flags) and lt.is_paid
                      then case when lr.half_day then 0.5 else 1 end else 0 end), 0)::double precision as paid_leave_days,
    coalesce(sum(case when 'on_leave' = any (eff.flags) and not lt.is_paid
                      then case when lr.half_day then 0.5 else 1 end else 0 end), 0)::double precision as unpaid_leave_days,
    count(*) filter (where eff.day_class = 'rest_day' and eff.first_in is not null)::int as rest_days_worked,
    count(*) filter (where eff.day_class in ('regular_holiday', 'special_holiday')
                       and eff.first_in is not null)::int         as holidays_worked,
    count(*) filter (where eff.first_in is not null
                       and not (coalesce(st.half_day_late_min, 60) > 0
                                and eff.late_minutes >= greatest(coalesce(st.half_day_late_min, 60) - coalesce(st.late_grace_min, 15), 1)))::int as full_days,
    ec.daily_rate,
    ec.daily_allowance,
    round((coalesce(sum(eff.late_minutes), 0) + coalesce(sum(eff.undertime_minutes), 0))
          * ec.daily_rate / 480.0, 2)                             as late_charge,
    coalesce(sum(floor(eff.overtime_minutes / 60.0)), 0)::int     as ot_paid_hours,
    round(coalesce(sum(floor(eff.overtime_minutes / 60.0)), 0) * ec.daily_rate * 1.25 / 8.0, 2) as ot_pay
  from public.attendance_effective eff
  join public.profiles p on p.id = eff.employee_id
  join public.branches b on b.id = eff.branch_id
  left join public.attendance_settings st on st.company_id = eff.company_id
  left join public.leave_requests lr on lr.id = eff.leave_request_id
  left join public.leave_types   lt on lt.id = lr.leave_type_id
  left join public.employee_compensation ec on ec.employee_id = p.id
  where eff.work_date between p_from and p_to
    and eff.status in ('approved', 'corrected')
    and (p_branch_id is null or eff.branch_id = p_branch_id)
  group by p.id, p.employee_code, p.full_name, b.id, b.name, ec.daily_rate, ec.daily_allowance
  order by b.name, p.full_name;
$$;

revoke all on function public.report_payroll_summary(date, date, uuid) from public;
grant execute on function public.report_payroll_summary(date, date, uuid) to authenticated;
