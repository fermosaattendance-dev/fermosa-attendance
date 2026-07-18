-- Two shifts per branch (pilot feedback 2026-07-18). Some branches run two
-- shifts (e.g. morning 9-6 + afternoon 12-9) with staff ROTATING day to day.
-- Today a branch has one shift_start/shift_end, so a 2nd-shift employee who
-- correctly arrives at 12 PM is flagged ~3 h late against the 9 AM start.
--
-- Decision: HR defines a 2nd shift on the branch; the employee PICKS which
-- shift they are timing in for (mirrors the roving-branch pick-at-time-in).
-- The picked shift rides the punch, pins the day's record (first punch wins),
-- and the engine measures late/undertime/OT against it via
-- coalesce(record.shift, branch.shift). Backward compatible: shift2 null =
-- single-shift branch, no picker, identical behavior.
--
-- MVP = day shifts (both within a calendar day). Overnight 2nd-shift day
-- attribution (punch_work_date) still uses the branch Shift-1 cutoff — noted,
-- deferred.

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------
alter table public.branches
  add column if not exists shift2_start time,
  add column if not exists shift2_end time;

-- The shift picked for a punch / pinned on the day (null = branch Shift 1).
alter table public.attendance_events
  add column if not exists shift_start time,
  add column if not exists shift_end time;
alter table public.attendance_records
  add column if not exists shift_start time,
  add column if not exists shift_end time;

-- ---------------------------------------------------------------------------
-- ingest_punch_as — full copy from 20260728000001_roving_branch.sql with the
-- chosen shift added: validate it matches the branch's Shift 1 or Shift 2,
-- then store it on the event.
-- ---------------------------------------------------------------------------
drop function if exists public.ingest_punch(uuid, public.punch_type, timestamptz, uuid, double precision, double precision, real, public.punch_source, jsonb, text);
drop function if exists public.ingest_punch_as(uuid, uuid, public.punch_type, timestamptz, uuid, double precision, double precision, real, public.punch_source, jsonb, text);

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
  p_selfie_path text default null,
  p_shift_start time default null,
  p_shift_end time default null
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

  if v_branch.id is null then
    if p_branch_id is not null then
      raise exception 'branch not found: % is not a branch of this company', p_branch_id;
    end if;
    raise exception 'no branch for this punch: your account has no home branch — select the branch you are working at and punch again';
  end if;

  -- A chosen shift must be one the branch actually defines (Shift 1 or Shift 2).
  if p_shift_start is not null then
    if not (
      (p_shift_start = v_branch.shift_start and p_shift_end = v_branch.shift_end)
      or (v_branch.shift2_start is not null
          and p_shift_start = v_branch.shift2_start and p_shift_end = v_branch.shift2_end)
    ) then
      raise exception 'invalid shift for this branch';
    end if;
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
    inside_geofence, distance_from_branch_m, device_info, selfie_path,
    shift_start, shift_end
  ) values (
    p_client_uuid, v_profile.company_id, v_profile.id, v_branch.id, p_type, p_source,
    p_happened_at, p_lat, p_lng, p_gps_accuracy_m,
    v_inside, v_distance_m, p_device_info, p_selfie_path,
    p_shift_start, p_shift_end
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

revoke all on function public.ingest_punch_as(uuid, uuid, public.punch_type, timestamptz, uuid, double precision, double precision, real, public.punch_source, jsonb, text, time, time) from public;
grant execute on function public.ingest_punch_as(uuid, uuid, public.punch_type, timestamptz, uuid, double precision, double precision, real, public.punch_source, jsonb, text, time, time) to service_role;

-- Personal-mode wrapper — identity from auth.uid(); passes the shift through.
create or replace function public.ingest_punch(
  p_client_uuid uuid,
  p_type public.punch_type,
  p_happened_at timestamptz,
  p_branch_id uuid default null,
  p_lat double precision default null,
  p_lng double precision default null,
  p_gps_accuracy_m real default null,
  p_source public.punch_source default 'mobile',
  p_device_info jsonb default null,
  p_selfie_path text default null,
  p_shift_start time default null,
  p_shift_end time default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  return public.ingest_punch_as(
    auth.uid(), p_client_uuid, p_type, p_happened_at, p_branch_id,
    p_lat, p_lng, p_gps_accuracy_m, p_source, p_device_info, p_selfie_path,
    p_shift_start, p_shift_end
  );
end;
$$;

revoke all on function public.ingest_punch(uuid, public.punch_type, timestamptz, uuid, double precision, double precision, real, public.punch_source, jsonb, text, time, time) from public;
grant execute on function public.ingest_punch(uuid, public.punch_type, timestamptz, uuid, double precision, double precision, real, public.punch_source, jsonb, text, time, time) to authenticated;

-- ---------------------------------------------------------------------------
-- Punch trigger — pin the day's shift from the first punch that carries one.
-- Full copy from 20260718000001_overnight_shifts.sql + the shift-pin update.
-- ---------------------------------------------------------------------------
create or replace function app.tg_upsert_attendance_record()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_date date;
  v_record_id uuid;
begin
  v_date := app.punch_work_date(new.branch_id, new.happened_at);

  insert into public.attendance_records (company_id, employee_id, branch_id, work_date)
  values (new.company_id, new.employee_id, new.branch_id, v_date)
  on conflict (employee_id, work_date) do nothing;

  select id into v_record_id from public.attendance_records
   where employee_id = new.employee_id and work_date = v_date;

  -- First punch that carries a chosen shift pins it on the day's record.
  if v_record_id is not null and new.shift_start is not null then
    update public.attendance_records
       set shift_start = new.shift_start, shift_end = new.shift_end
     where id = v_record_id and shift_start is null;
  end if;

  if v_record_id is not null then
    perform app.compute_attendance_record(v_record_id);
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Engine — measure against the picked shift. Full copy from
-- 20260727000001_time_corrections.sql; only the v_shift_start/v_shift_end
-- source changes (coalesce the record's pinned shift over the branch default).
-- ---------------------------------------------------------------------------
create or replace function app.compute_attendance_record(p_record_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.attendance_records%rowtype;
  b public.branches%rowtype;
  s public.attendance_settings%rowtype;
  v_tz text;
  v_day_start timestamptz;
  v_day_end timestamptz;
  v_first_in timestamptz;
  v_last_out timestamptz;
  v_break_min int := 0;
  v_span_min int;
  v_worked int;
  v_late int := 0;
  v_under int := 0;
  v_ot int := 0;
  v_flags text[] := '{}';
  v_class public.day_class := 'regular';
  v_kind public.holiday_kind;
  v_shift_start timestamptz;
  v_shift_end timestamptz;
  v_eff_start time;   -- picked shift over branch default
  v_eff_end time;
  v_cutoff time := '00:00';
  v_deduct int;
  ev record;
  v_open_break timestamptz;
  v_has_punches boolean := false;
  v_leave_id uuid;
  v_time_gap boolean := false;
begin
  select * into r from public.attendance_records where id = p_record_id;
  if r.id is null then return; end if;

  select * into b from public.branches where id = r.branch_id;
  select * into s from public.attendance_settings where company_id = r.company_id;
  if s.company_id is null then
    s.late_grace_min := 15; s.ot_threshold_min := 30; s.min_break_min := 60;
    s.half_day_late_min := 60;
  end if;

  v_tz := coalesce(b.timezone, 'Asia/Manila');
  if b.id is not null then
    v_cutoff := app.work_day_cutoff(b.shift_start, b.shift_end);
  end if;
  v_day_start := (r.work_date + v_cutoff) at time zone v_tz;
  v_day_end := v_day_start + interval '1 day';

  select kind into v_kind from public.holidays
   where company_id = r.company_id and holiday_date = r.work_date;
  if v_kind = 'regular' then
    v_class := 'regular_holiday';
  elsif v_kind = 'special' then
    v_class := 'special_holiday';
  elsif b.id is not null and not (extract(isodow from r.work_date)::int = any (b.work_days)) then
    v_class := 'rest_day';
  end if;

  select id into v_leave_id from public.leave_requests
   where employee_id = r.employee_id
     and status = 'approved'
     and r.work_date between start_date and end_date
   order by created_at
   limit 1;

  for ev in
    select type, happened_at, received_at from public.attendance_events
     where employee_id = r.employee_id
       and happened_at >= v_day_start and happened_at < v_day_end
     order by happened_at
  loop
    v_has_punches := true;
    if ev.type in ('clock_in', 'clock_out')
       and abs(extract(epoch from ev.received_at - ev.happened_at)) > 600 then
      v_time_gap := true;
    end if;
    if ev.type = 'clock_in' and v_first_in is null then
      v_first_in := ev.happened_at;
    elsif ev.type = 'clock_out' then
      v_last_out := ev.happened_at;
    elsif ev.type = 'break_start' then
      v_open_break := ev.happened_at;
    elsif ev.type = 'break_end' and v_open_break is not null then
      v_break_min := v_break_min + greatest(0, extract(epoch from ev.happened_at - v_open_break) / 60)::int;
      v_open_break := null;
    end if;
  end loop;

  if not v_has_punches then
    update public.attendance_records
       set first_in = null, last_out = null, worked_minutes = 0, break_minutes = 0,
           late_minutes = 0, undertime_minutes = 0, overtime_minutes = 0,
           day_class = v_class,
           flags = case when v_leave_id is not null then array['on_leave'] else array['absent'] end,
           leave_request_id = v_leave_id,
           computed_at = now()
     where id = p_record_id;
    return;
  end if;

  -- Effective shift: the shift the employee picked for this day, else the
  -- branch's Shift 1. This is the ONLY change from the prior engine.
  if b.id is not null then
    v_eff_start := coalesce(r.shift_start, b.shift_start);
    v_eff_end := coalesce(r.shift_end, b.shift_end);
    v_shift_start := (r.work_date::timestamp + v_eff_start) at time zone v_tz;
    v_shift_end := (r.work_date::timestamp + v_eff_end) at time zone v_tz
                   + case when v_eff_end <= v_eff_start then interval '1 day' else interval '0' end;
  end if;

  if v_first_in is not null and v_last_out is not null and v_last_out > v_first_in then
    v_span_min := (extract(epoch from v_last_out - v_first_in) / 60)::int;
    v_deduct := case when v_span_min > 5 * 60 then greatest(v_break_min, s.min_break_min) else v_break_min end;
    v_worked := greatest(0, v_span_min - v_deduct);
    v_break_min := v_deduct;
  else
    v_worked := null;
  end if;

  if v_shift_start is not null and v_first_in is not null then
    v_late := greatest(0, (extract(epoch from v_first_in - v_shift_start) / 60)::int - s.late_grace_min);
  end if;

  if v_shift_end is not null and v_last_out is not null then
    v_under := greatest(0, (extract(epoch from v_shift_end - v_last_out) / 60)::int);
    v_ot := greatest(0, (extract(epoch from v_last_out - v_shift_end) / 60)::int);
    if v_ot <= s.ot_threshold_min then v_ot := 0; end if;
  end if;

  if v_first_in is not null and v_last_out is null then
    v_flags := array_append(v_flags, 'no_clock_out');
  end if;
  if v_late > 0 then
    v_flags := array_append(v_flags, 'late');
  elsif v_first_in is not null then
    v_flags := array_append(v_flags, 'on_time');
  end if;
  if s.half_day_late_min > 0
     and v_late >= greatest(s.half_day_late_min - s.late_grace_min, 1) then
    v_flags := array_append(v_flags, 'half_day');
  end if;
  if v_under > 0 and v_last_out is not null then v_flags := array_append(v_flags, 'early_out'); end if;
  if v_ot > 0 then v_flags := array_append(v_flags, 'overtime'); end if;
  if v_leave_id is not null then v_flags := array_append(v_flags, 'on_leave'); end if;
  if v_time_gap then v_flags := array_append(v_flags, 'time_mismatch'); end if;

  update public.attendance_records
     set first_in = v_first_in,
         last_out = v_last_out,
         worked_minutes = v_worked,
         break_minutes = v_break_min,
         late_minutes = v_late,
         undertime_minutes = v_under,
         overtime_minutes = v_ot,
         day_class = v_class,
         flags = v_flags,
         leave_request_id = v_leave_id,
         computed_at = now()
   where id = p_record_id;
end;
$$;
