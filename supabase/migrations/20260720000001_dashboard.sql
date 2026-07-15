-- M7: Live operations dashboard (Phase 7).
-- One SECURITY INVOKER function returns a per-employee "right now" roster for
-- the caller's visible scope — RLS on profiles/attendance_events/records/leave
-- filters it automatically (branch managers see their branch, HR/ops the whole
-- company). Read-only; no schema changes to existing tables.
--
-- "Right now" honors the M5 per-branch work day: an employee's status comes
-- from their latest punch within the current work-day window
-- (app.punch_work_date / app.work_day_cutoff), so overnight branches read
-- against the shift that's actually running.

create or replace function public.dashboard_live()
returns table (
  employee_id uuid,
  full_name text,
  employee_code text,
  branch_id uuid,
  branch_name text,
  status text,          -- working | on_break | clocked_out | not_in
  scheduled boolean,    -- branch works this weekday and it isn't a holiday
  on_leave boolean,     -- approved leave covers the current work day
  overdue boolean,      -- scheduled, no punch, not on leave, past shift start + grace
  late_minutes int,
  first_in timestamptz,
  last_punch_at timestamptz,
  work_date date
)
language sql
stable
set search_path = public
as $$
  with base as (
    select p.id as employee_id, p.full_name, p.employee_code,
           p.branch_id, b.name as branch_name, p.company_id,
           b.timezone, b.shift_start, b.work_days,
           app.punch_work_date(p.branch_id, now()) as wd,
           coalesce(s.late_grace_min, 15) as grace,
           (app.punch_work_date(p.branch_id, now())
             + app.work_day_cutoff(b.shift_start, b.shift_end)) at time zone b.timezone as day_start
      from public.profiles p
      join public.branches b on b.id = p.branch_id and b.is_active
      left join public.attendance_settings s on s.company_id = p.company_id
     where p.employment_status in ('active', 'probationary')
  )
  select
    l.employee_id,
    l.full_name,
    l.employee_code,
    l.branch_id,
    l.branch_name,
    case lp.last_type
      when 'clock_in' then 'working'
      when 'break_end' then 'working'
      when 'break_start' then 'on_break'
      when 'clock_out' then 'clocked_out'
      else 'not_in'
    end as status,
    sched.scheduled,
    lv.on_leave,
    (
      lp.last_type is null
      and sched.scheduled
      and not lv.on_leave
      and now() > ((l.wd::timestamp + l.shift_start) at time zone l.timezone + make_interval(mins => l.grace))
    ) as overdue,
    coalesce(ar.late_minutes, 0) as late_minutes,
    ar.first_in,
    lp.last_at as last_punch_at,
    l.wd as work_date
  from base l
  cross join lateral (
    select (extract(isodow from l.wd)::int = any (l.work_days)
            and not exists (
              select 1 from public.holidays h
               where h.company_id = l.company_id and h.holiday_date = l.wd
            )) as scheduled
  ) sched
  cross join lateral (
    select exists (
      select 1 from public.leave_requests lr
       where lr.employee_id = l.employee_id and lr.status = 'approved'
         and l.wd between lr.start_date and lr.end_date
    ) as on_leave
  ) lv
  left join lateral (
    select ev.type as last_type, ev.happened_at as last_at
      from public.attendance_events ev
     where ev.employee_id = l.employee_id
       and ev.happened_at >= l.day_start
       and ev.happened_at < l.day_start + interval '1 day'
     order by ev.happened_at desc
     limit 1
  ) lp on true
  left join public.attendance_records ar
    on ar.employee_id = l.employee_id and ar.work_date = l.wd;
$$;

revoke all on function public.dashboard_live() from public;
grant execute on function public.dashboard_live() to authenticated;
