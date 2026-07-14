-- M4: Attendance Engine — turns raw punches into payroll-grade daily numbers.
-- Business rules (user decisions, 2026-07-14):
--   * Branch schedules are set by HR per branch (per-employee shifts arrive in M5)
--   * Late grace 15 min; once past grace, late minutes count from shift start
--   * Break deduction: max(punched breaks, 60 min) when the day spans > 5 h
--   * Overtime counts only past 30 min after shift end, and is a FLAG —
--     it reaches payroll only through HR-approved records

-- ---------------------------------------------------------------------------
-- Per-branch default schedule (HR-editable through existing branches RLS).
-- work_days uses ISO weekday numbers: 1 = Monday … 7 = Sunday.
-- ---------------------------------------------------------------------------

alter table public.branches
  add column shift_start time not null default '10:00',
  add column shift_end   time not null default '19:00',
  add column work_days   int[] not null default '{1,2,3,4,5,6}';

-- ---------------------------------------------------------------------------
-- Company-wide engine settings.
-- ---------------------------------------------------------------------------

create table public.attendance_settings (
  company_id uuid primary key references public.companies (id) on delete cascade,
  late_grace_min int not null default 15 check (late_grace_min between 0 and 120),
  ot_threshold_min int not null default 30 check (ot_threshold_min between 0 and 240),
  min_break_min int not null default 60 check (min_break_min between 0 and 240),
  updated_at timestamptz not null default now()
);

create trigger attendance_settings_updated_at
  before update on public.attendance_settings
  for each row execute function public.tg_set_updated_at();

alter table public.attendance_settings enable row level security;

create policy attendance_settings_select on public.attendance_settings
  for select to authenticated
  using (company_id = app.user_company_id());

create policy attendance_settings_write on public.attendance_settings
  for all to authenticated
  using (company_id = app.user_company_id() and app.is_company_admin())
  with check (company_id = app.user_company_id() and app.is_company_admin());

insert into public.attendance_settings (company_id)
values ('c0000000-0000-0000-0000-000000000001')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Holidays (PH national; admins maintain via dashboard).
-- ---------------------------------------------------------------------------

create type public.holiday_kind as enum ('regular', 'special');

create table public.holidays (
  id uuid primary key default uuid_generate_v4(),
  company_id uuid not null references public.companies (id) on delete cascade,
  holiday_date date not null,
  name text not null,
  kind public.holiday_kind not null default 'regular',
  unique (company_id, holiday_date)
);

alter table public.holidays enable row level security;

create policy holidays_select on public.holidays
  for select to authenticated
  using (company_id = app.user_company_id());

create policy holidays_write on public.holidays
  for all to authenticated
  using (company_id = app.user_company_id() and app.is_company_admin())
  with check (company_id = app.user_company_id() and app.is_company_admin());

insert into public.holidays (company_id, holiday_date, name, kind) values
  ('c0000000-0000-0000-0000-000000000001', '2026-01-01', 'New Year''s Day', 'regular'),
  ('c0000000-0000-0000-0000-000000000001', '2026-04-02', 'Maundy Thursday', 'regular'),
  ('c0000000-0000-0000-0000-000000000001', '2026-04-03', 'Good Friday', 'regular'),
  ('c0000000-0000-0000-0000-000000000001', '2026-04-04', 'Black Saturday', 'special'),
  ('c0000000-0000-0000-0000-000000000001', '2026-04-09', 'Araw ng Kagitingan', 'regular'),
  ('c0000000-0000-0000-0000-000000000001', '2026-05-01', 'Labor Day', 'regular'),
  ('c0000000-0000-0000-0000-000000000001', '2026-06-12', 'Independence Day', 'regular'),
  ('c0000000-0000-0000-0000-000000000001', '2026-08-21', 'Ninoy Aquino Day', 'special'),
  ('c0000000-0000-0000-0000-000000000001', '2026-08-31', 'National Heroes Day', 'regular'),
  ('c0000000-0000-0000-0000-000000000001', '2026-11-01', 'All Saints'' Day', 'special'),
  ('c0000000-0000-0000-0000-000000000001', '2026-11-30', 'Bonifacio Day', 'regular'),
  ('c0000000-0000-0000-0000-000000000001', '2026-12-08', 'Immaculate Conception', 'special'),
  ('c0000000-0000-0000-0000-000000000001', '2026-12-25', 'Christmas Day', 'regular'),
  ('c0000000-0000-0000-0000-000000000001', '2026-12-30', 'Rizal Day', 'regular'),
  ('c0000000-0000-0000-0000-000000000001', '2026-12-31', 'New Year''s Eve', 'special')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Engine columns on attendance_records.
-- ---------------------------------------------------------------------------

create type public.day_class as enum ('regular', 'rest_day', 'regular_holiday', 'special_holiday');

alter table public.attendance_records
  add column first_in timestamptz,
  add column last_out timestamptz,
  add column worked_minutes int,
  add column break_minutes int,
  add column late_minutes int,
  add column undertime_minutes int,
  add column overtime_minutes int,
  add column day_class public.day_class,
  add column flags text[] not null default '{}',
  add column corrections jsonb,
  add column computed_at timestamptz;

-- ---------------------------------------------------------------------------
-- The engine. Pure computation: never touches status or corrections.
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
  v_deduct int;
  ev record;
  v_open_break timestamptz;
  v_has_punches boolean := false;
begin
  select * into r from public.attendance_records where id = p_record_id;
  if r.id is null then return; end if;

  select * into b from public.branches where id = r.branch_id;
  select * into s from public.attendance_settings where company_id = r.company_id;
  if s.company_id is null then
    -- engine defaults when a company has no settings row
    s.late_grace_min := 15; s.ot_threshold_min := 30; s.min_break_min := 60;
  end if;

  v_tz := coalesce(b.timezone, 'Asia/Manila');
  v_day_start := (r.work_date::timestamp) at time zone v_tz;
  v_day_end := v_day_start + interval '1 day';

  -- Day classification: holiday > rest day > regular.
  select kind into v_kind from public.holidays
   where company_id = r.company_id and holiday_date = r.work_date;
  if v_kind = 'regular' then
    v_class := 'regular_holiday';
  elsif v_kind = 'special' then
    v_class := 'special_holiday';
  elsif b.id is not null and not (extract(isodow from r.work_date)::int = any (b.work_days)) then
    v_class := 'rest_day';
  end if;

  -- Walk the day's punches in order.
  for ev in
    select type, happened_at from public.attendance_events
     where employee_id = r.employee_id
       and happened_at >= v_day_start and happened_at < v_day_end
     order by happened_at
  loop
    v_has_punches := true;
    if ev.type = 'clock_in' and v_first_in is null then
      v_first_in := ev.happened_at;
    elsif ev.type = 'clock_out' then
      v_last_out := ev.happened_at; -- last one wins
    elsif ev.type = 'break_start' then
      v_open_break := ev.happened_at;
    elsif ev.type = 'break_end' and v_open_break is not null then
      v_break_min := v_break_min + greatest(0, extract(epoch from ev.happened_at - v_open_break) / 60)::int;
      v_open_break := null;
    end if;
  end loop;

  if not v_has_punches then
    -- Absent day (created by the sweep): zeroed numbers, absent flag.
    update public.attendance_records
       set first_in = null, last_out = null, worked_minutes = 0, break_minutes = 0,
           late_minutes = 0, undertime_minutes = 0, overtime_minutes = 0,
           day_class = v_class, flags = array['absent'], computed_at = now()
     where id = p_record_id;
    return;
  end if;

  if b.id is not null then
    v_shift_start := (r.work_date::timestamp + b.shift_start) at time zone v_tz;
    v_shift_end := (r.work_date::timestamp + b.shift_end) at time zone v_tz;
  end if;

  if v_first_in is not null and v_last_out is not null and v_last_out > v_first_in then
    v_span_min := (extract(epoch from v_last_out - v_first_in) / 60)::int;
    -- Break rule: on days spanning > 5 h, deduct at least the minimum break.
    v_deduct := case when v_span_min > 5 * 60 then greatest(v_break_min, s.min_break_min) else v_break_min end;
    v_worked := greatest(0, v_span_min - v_deduct);
    v_break_min := v_deduct;
  else
    v_worked := null; -- incomplete day: HR corrects or the flag stands
  end if;

  if v_shift_start is not null and v_first_in is not null then
    v_late := greatest(0, (extract(epoch from v_first_in - v_shift_start) / 60)::int);
    if v_late <= s.late_grace_min then v_late := 0; end if;
  end if;

  if v_shift_end is not null and v_last_out is not null then
    v_under := greatest(0, (extract(epoch from v_shift_end - v_last_out) / 60)::int);
    v_ot := greatest(0, (extract(epoch from v_last_out - v_shift_end) / 60)::int);
    if v_ot <= s.ot_threshold_min then v_ot := 0; end if;
  end if;

  -- Flags: system verdicts, independent of approval status.
  if v_first_in is not null and v_last_out is null then
    v_flags := array_append(v_flags, 'no_clock_out');
  end if;
  if v_late > 0 then
    v_flags := array_append(v_flags, 'late');
  elsif v_first_in is not null then
    v_flags := array_append(v_flags, 'on_time');
  end if;
  if v_under > 0 and v_last_out is not null then v_flags := array_append(v_flags, 'early_out'); end if;
  if v_ot > 0 then v_flags := array_append(v_flags, 'overtime'); end if;

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
         computed_at = now()
   where id = p_record_id;
end;
$$;

-- Recompute after every punch: extend the M3 trigger function.
create or replace function app.tg_upsert_attendance_record()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tz text;
  v_date date;
  v_record_id uuid;
begin
  select coalesce(b.timezone, 'Asia/Manila') into v_tz
    from public.branches b where b.id = new.branch_id;
  v_date := (new.happened_at at time zone coalesce(v_tz, 'Asia/Manila'))::date;

  insert into public.attendance_records (company_id, employee_id, branch_id, work_date)
  values (new.company_id, new.employee_id, new.branch_id, v_date)
  on conflict (employee_id, work_date) do nothing;

  select id into v_record_id from public.attendance_records
   where employee_id = new.employee_id and work_date = v_date;
  if v_record_id is not null then
    perform app.compute_attendance_record(v_record_id);
  end if;
  return new;
end;
$$;

-- Manual recompute for admins (e.g. after editing a branch schedule).
create or replace function public.recompute_attendance(p_record_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not app.is_company_admin() then
    raise exception 'only company admins can recompute attendance';
  end if;
  if not exists (
    select 1 from public.attendance_records
     where id = p_record_id and company_id = app.user_company_id()
  ) then
    raise exception 'attendance record not found in your company';
  end if;
  perform app.compute_attendance_record(p_record_id);
end;
$$;

revoke all on function public.recompute_attendance(uuid) from public;
grant execute on function public.recompute_attendance(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Corrections: review_attendance learns minute overrides (stored separately;
-- the engine never overwrites them).
-- ---------------------------------------------------------------------------

drop function public.review_attendance(uuid, public.attendance_status, text);

create or replace function public.review_attendance(
  p_record_id uuid,
  p_status public.attendance_status,
  p_note text default null,
  p_corrections jsonb default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_record public.attendance_records%rowtype;
  v_allowed_keys text[] := array['worked_minutes', 'late_minutes', 'undertime_minutes', 'overtime_minutes', 'break_minutes'];
  k text;
begin
  if not app.is_company_admin() then
    raise exception 'only HR, operations manager, or super admin can review attendance';
  end if;
  if p_status = 'pending_review' then
    raise exception 'cannot set a record back to pending review';
  end if;
  if p_status in ('rejected', 'corrected') and coalesce(trim(p_note), '') = '' then
    raise exception 'a note is required when rejecting or correcting';
  end if;
  if p_corrections is not null then
    for k in select jsonb_object_keys(p_corrections) loop
      if not (k = any (v_allowed_keys)) then
        raise exception 'invalid correction field: %', k;
      end if;
      if jsonb_typeof(p_corrections->k) <> 'number' then
        raise exception 'correction % must be a number of minutes', k;
      end if;
    end loop;
  end if;

  update public.attendance_records
     set status = p_status,
         review_note = p_note,
         corrections = case when p_status = 'corrected' then p_corrections else corrections end,
         reviewed_by = auth.uid(),
         reviewed_at = now()
   where id = p_record_id
     and company_id = app.user_company_id()
   returning * into v_record;

  if v_record.id is null then
    raise exception 'attendance record not found in your company';
  end if;

  insert into public.audit_logs (company_id, actor_id, action, table_name, record_id, details)
  values (
    v_record.company_id, auth.uid(), 'attendance_reviewed', 'attendance_records',
    v_record.id::text,
    jsonb_build_object('status', p_status, 'note', p_note, 'corrections', p_corrections,
                       'employee_id', v_record.employee_id, 'work_date', v_record.work_date)
  );
end;
$$;

revoke all on function public.review_attendance(uuid, public.attendance_status, text, jsonb) from public;
grant execute on function public.review_attendance(uuid, public.attendance_status, text, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Nightly sweep: absent records for scheduled-but-silent employees, and a
-- final recompute of yesterday's incomplete days. Scheduled via pg_cron.
-- ---------------------------------------------------------------------------

create or replace function app.nightly_attendance_sweep()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_yesterday date := ((now() at time zone 'Asia/Manila')::date - 1);
  rec record;
begin
  -- Absent: active employee, branch scheduled to work, no holiday, no record.
  for rec in
    select p.id as employee_id, p.company_id, p.branch_id
      from public.profiles p
      join public.branches b on b.id = p.branch_id and b.is_active
     where p.employment_status in ('active', 'probationary')
       and extract(isodow from v_yesterday)::int = any (b.work_days)
       and not exists (
         select 1 from public.holidays h
          where h.company_id = p.company_id and h.holiday_date = v_yesterday
       )
       and not exists (
         select 1 from public.attendance_records ar
          where ar.employee_id = p.id and ar.work_date = v_yesterday
       )
  loop
    insert into public.attendance_records (company_id, employee_id, branch_id, work_date)
    values (rec.company_id, rec.employee_id, rec.branch_id, v_yesterday)
    on conflict do nothing;
  end loop;

  -- (Re)compute everything from yesterday still pending — closes out
  -- no-clock-out days and fills the freshly created absent records.
  for rec in
    select id from public.attendance_records
     where work_date = v_yesterday and status = 'pending_review'
  loop
    perform app.compute_attendance_record(rec.id);
  end loop;
end;
$$;

create extension if not exists pg_cron;

-- 02:00 Manila = 18:00 UTC.
select cron.schedule('nightly-attendance-sweep', '0 18 * * *', 'select app.nightly_attendance_sweep()');
