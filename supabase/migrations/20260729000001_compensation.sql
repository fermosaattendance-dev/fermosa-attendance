-- Employee compensation: monthly salary rate + per-full-day allowance.
-- User decisions (2026-07-17):
--   * Rate is PER MONTH; allowance is PER DAY PRESENT but only FULL days —
--     a half-day (late past the half-day mark) earns no allowance.
--   * The system carries these as columns into the payroll report/sheet;
--     it does NOT compute gross pay (deduction/OT rules stay with payroll).
--   * Visibility: HR / operations manager / super admin ONLY, enforced here.
--     Salary cannot live on profiles — RLS is row-level, and branch managers
--     + the employee themselves can read profile rows.

-- ---------------------------------------------------------------------------
-- Table: one row per employee, admin-only.
-- ---------------------------------------------------------------------------

create table public.employee_compensation (
  employee_id uuid primary key references public.profiles (id) on delete cascade,
  company_id uuid not null references public.companies (id) on delete cascade,
  monthly_rate numeric(10,2) not null default 0 check (monthly_rate >= 0),
  daily_allowance numeric(8,2) not null default 0 check (daily_allowance >= 0),
  updated_by uuid references public.profiles (id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table public.employee_compensation enable row level security;

-- The ONLY policy: company admins. Branch managers and employees get nothing.
create policy compensation_admin on public.employee_compensation
  for all to authenticated
  using (company_id = app.user_company_id() and app.is_company_admin())
  with check (company_id = app.user_company_id() and app.is_company_admin());

-- ---------------------------------------------------------------------------
-- Prepare trigger: company_id always comes from the target employee's profile
-- (client value ignored); stamp who/when. Runs as the caller, so RLS on
-- profiles makes a cross-company employee_id resolve to "not found".
-- ---------------------------------------------------------------------------

create or replace function app.tg_compensation_prepare()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_company uuid;
begin
  select company_id into v_company from public.profiles where id = new.employee_id;
  if v_company is null then
    raise exception 'employee not found';
  end if;
  new.company_id := v_company;
  new.updated_by := auth.uid();
  new.updated_at := now();
  return new;
end;
$$;

create trigger compensation_prepare
  before insert or update on public.employee_compensation
  for each row execute function app.tg_compensation_prepare();

-- ---------------------------------------------------------------------------
-- Audit trigger: rate changes land in audit_logs (admin-only read).
-- security definer lets it insert despite the no-direct-write policy.
-- ---------------------------------------------------------------------------

create or replace function app.tg_audit_compensation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT'
     or new.monthly_rate is distinct from old.monthly_rate
     or new.daily_allowance is distinct from old.daily_allowance then
    insert into public.audit_logs (company_id, actor_id, action, table_name, record_id, details)
    values (
      new.company_id,
      auth.uid(),
      'compensation_set',
      'employee_compensation',
      new.employee_id::text,
      jsonb_build_object(
        'old', case when tg_op = 'UPDATE'
          then jsonb_build_object('monthly_rate', old.monthly_rate, 'daily_allowance', old.daily_allowance)
          else null end,
        'new', jsonb_build_object('monthly_rate', new.monthly_rate, 'daily_allowance', new.daily_allowance)
      )
    );
  end if;
  return new;
end;
$$;

create trigger compensation_audit
  after insert or update on public.employee_compensation
  for each row execute function app.tg_audit_compensation();

-- ---------------------------------------------------------------------------
-- Payroll summary: append full_days (days present that were NOT half-day-late,
-- for allowance = full_days × daily_allowance) + the two rates. Return type
-- changes, so drop + recreate; body copied verbatim from
-- 20260727000001_time_corrections.sql with the three columns appended.
-- SECURITY INVOKER: branch managers get NULL rates (RLS hides the join rows).
-- ---------------------------------------------------------------------------

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
  monthly_rate      numeric,
  daily_allowance   numeric
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
    ec.monthly_rate,
    ec.daily_allowance
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
  group by p.id, p.employee_code, p.full_name, b.id, b.name, ec.monthly_rate, ec.daily_allowance
  order by b.name, p.full_name;
$$;

revoke all on function public.report_payroll_summary(date, date, uuid) from public;
grant execute on function public.report_payroll_summary(date, date, uuid) to authenticated;
