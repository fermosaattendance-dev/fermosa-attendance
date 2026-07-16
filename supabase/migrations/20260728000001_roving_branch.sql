-- Roving staff: pick your branch at time-in (pilot feedback round 3).
--
-- Convention: profiles.branch_id IS NULL = roving/supervisor staff with no
-- permanent branch (user decision 2026-07-16). They select which branch they
-- are at on the time-in screens; the punch carries that branch, so the
-- geofence, the daily record, the engine's shift math, branch-manager RLS and
-- payroll all already follow it (they key off the event/record branch).
--
-- Two backend changes:
--   1. ingest_punch_as: raise a clear error when no branch resolves, instead
--      of silently inserting a branchless, un-geofenced punch.
--   2. dashboard_live(): roving employees no longer vanish from the live
--      board — they appear under the branch of their latest punch (last 20 h),
--      or as "not in" with no branch before they punch.
--
-- Audited, intentionally unchanged:
--   - app.nightly_attendance_sweep joins profiles.branch_id, so roving staff
--     are never swept absent — correct: they are not scheduled anywhere fixed.
--   - app.leave_day_count already falls back to Mon–Sat work days when the
--     employee has no branch.
--   - RLS: branch managers are scoped by the event/record branch, so the
--     manager of the branch being filled in sees the roving punches.

-- ---------------------------------------------------------------------------
-- 1. ingest_punch_as — full copy from 20260716000001_verification.sql with one
--    surgical addition: fail loudly when no branch resolves.
-- ---------------------------------------------------------------------------

create or replace function public.ingest_punch_as(
  p_employee_id uuid,
  p_client_uuid uuid,
  p_type public.punch_type,
  p_happened_at timestamptz,
  p_branch_id uuid default null,
  p_lat double precision default null,
  p_lng double precision default null,
  p_gps_accuracy_m real default null,
  p_source public.punch_source default 'mobile',
  p_device_info jsonb default null,
  p_selfie_path text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.profiles%rowtype;
  v_branch public.branches%rowtype;
  v_distance_m real;
  v_inside boolean;
  v_id uuid;
  v_existing uuid;
begin
  select * into v_profile from public.profiles where id = p_employee_id;
  if v_profile.id is null then
    raise exception 'no employee profile for id %', p_employee_id;
  end if;

  select * into v_branch
    from public.branches
   where id = coalesce(p_branch_id, v_profile.branch_id)
     and company_id = v_profile.company_id;

  -- Every punch must carry a real branch: the geofence, the daily record and
  -- the shift math all depend on it. Roving employees (no home branch) must
  -- send the branch they picked.
  if v_branch.id is null then
    if p_branch_id is not null then
      raise exception 'branch not found: % is not a branch of this company', p_branch_id;
    end if;
    raise exception 'no branch for this punch: your account has no home branch — select the branch you are working at and punch again';
  end if;

  if v_branch.id is not null and p_lat is not null and p_lng is not null then
    v_distance_m := (
      2 * 6371000 * asin(sqrt(
        power(sin(radians(p_lat - v_branch.lat) / 2), 2)
        + cos(radians(v_branch.lat)) * cos(radians(p_lat))
          * power(sin(radians(p_lng - v_branch.lng) / 2), 2)
      ))
    )::real;
    v_inside := v_distance_m <= v_branch.geofence_radius_m;
  end if;

  insert into public.attendance_events (
    client_uuid, company_id, employee_id, branch_id, type, source,
    happened_at, lat, lng, gps_accuracy_m,
    inside_geofence, distance_from_branch_m, device_info, selfie_path
  ) values (
    p_client_uuid, v_profile.company_id, v_profile.id, v_branch.id, p_type, p_source,
    p_happened_at, p_lat, p_lng, p_gps_accuracy_m,
    v_inside, v_distance_m, p_device_info, p_selfie_path
  )
  on conflict (client_uuid) do nothing
  returning id into v_id;

  if v_id is null then
    select id into v_existing from public.attendance_events where client_uuid = p_client_uuid;
    return jsonb_build_object('id', v_existing, 'duplicate', true);
  end if;

  return jsonb_build_object(
    'id', v_id, 'duplicate', false,
    'inside_geofence', v_inside, 'distance_m', v_distance_m
  );
end;
$$;

revoke all on function public.ingest_punch_as(uuid, uuid, public.punch_type, timestamptz, uuid, double precision, double precision, real, public.punch_source, jsonb, text) from public;
grant execute on function public.ingest_punch_as(uuid, uuid, public.punch_type, timestamptz, uuid, double precision, double precision, real, public.punch_source, jsonb, text) to service_role;

-- ---------------------------------------------------------------------------
-- 2. dashboard_live — full copy from 20260720000001_dashboard.sql. The old
--    single base CTE becomes reg (verbatim + a has_home_branch flag) UNION ALL
--    a new rov CTE for null-branch employees, whose "today" branch is the
--    branch of their latest punch in the last 20 hours. Regular employees'
--    rows are byte-identical to before (the coalesce/flag edits are no-ops
--    when a home branch exists).
-- ---------------------------------------------------------------------------

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
  with reg as (
    select p.id as employee_id, p.full_name, p.employee_code,
           p.branch_id, b.name as branch_name, p.company_id,
           b.timezone, b.shift_start, b.work_days,
           app.punch_work_date(p.branch_id, now()) as wd,
           coalesce(s.late_grace_min, 15) as grace,
           (app.punch_work_date(p.branch_id, now())
             + app.work_day_cutoff(b.shift_start, b.shift_end)) at time zone b.timezone as day_start,
           true as has_home_branch
      from public.profiles p
      join public.branches b on b.id = p.branch_id and b.is_active
      left join public.attendance_settings s on s.company_id = p.company_id
     where p.employment_status in ('active', 'probationary')
  ),
  rov as (
    -- Roving employees (profiles.branch_id is null): today's branch is the
    -- branch of their latest punch in the last 20 hours. No punch yet ->
    -- null branch, not_in, never overdue (nowhere they are expected to be).
    select p.id as employee_id, p.full_name, p.employee_code,
           b.id as branch_id, b.name as branch_name, p.company_id,
           b.timezone, b.shift_start, b.work_days,
           app.punch_work_date(b.id, now()) as wd,  -- null branch -> Manila calendar today
           coalesce(s.late_grace_min, 15) as grace,
           case when b.id is not null then
             (app.punch_work_date(b.id, now())
               + app.work_day_cutoff(b.shift_start, b.shift_end)) at time zone b.timezone
           end as day_start,
           false as has_home_branch
      from public.profiles p
      left join lateral (
        select ev.branch_id
          from public.attendance_events ev
         where ev.employee_id = p.id
           and ev.branch_id is not null
           and ev.happened_at >= now() - interval '20 hours'
         order by ev.happened_at desc
         limit 1
      ) le on true
      left join public.branches b on b.id = le.branch_id
      left join public.attendance_settings s on s.company_id = p.company_id
     where p.branch_id is null
       and p.employment_status in ('active', 'probationary')
  ),
  base as (
    select * from reg
    union all
    select * from rov
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
    coalesce(sched.scheduled, false) as scheduled,
    lv.on_leave,
    (
      l.has_home_branch
      and lp.last_type is null
      and coalesce(sched.scheduled, false)
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
