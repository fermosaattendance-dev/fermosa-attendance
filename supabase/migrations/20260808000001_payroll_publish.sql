-- Deploying payslips to staff (pilot request 2026-07-20).
--
-- HR fills a cutoff, double-checks it, then "deploys" it — only then can
-- employees see their own payslip. Two rules are enforced HERE rather than in
-- the UI, because they are the whole point of the feature:
--
--   1. An employee can read ONLY their own payslip, and ONLY once the period is
--      deployed. Salary lives in admin-only tables (employee_compensation,
--      payroll_adjustments) and stays that way — employees get a single
--      security-definer RPC instead of any table access.
--   2. A deployed period is LOCKED. Once staff can see a payslip, its amounts
--      must not shift underneath them; HR un-deploys to correct, then re-deploys.

-- ---------------------------------------------------------------------------
-- Table: one row per company per pay period.
-- ---------------------------------------------------------------------------

create table public.payroll_periods (
  company_id   uuid not null references public.companies (id) on delete cascade,
  period_start date not null,
  period_end   date not null,
  published_at timestamptz,
  published_by uuid references public.profiles (id) on delete set null,
  primary key (company_id, period_start)
);

alter table public.payroll_periods enable row level security;

-- Admin-only, like the other payroll tables. Employees reach the publish state
-- through my_payslip()/my_payslip_periods(), never by reading this table.
create policy payroll_periods_admin on public.payroll_periods
  for all to authenticated
  using (company_id = app.user_company_id() and app.is_company_admin())
  with check (company_id = app.user_company_id() and app.is_company_admin());

-- ---------------------------------------------------------------------------
-- Lock: block writes to a deployed period. Redefines the prepare trigger from
-- 20260807000001_payroll_adjustments.sql with the published check added.
-- ---------------------------------------------------------------------------

create or replace function app.tg_payroll_adjustments_prepare()
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
  if new.period_end < new.period_start then
    raise exception 'period_end is before period_start';
  end if;

  -- A deployed payslip is final until HR un-deploys it.
  if exists (
    select 1 from public.payroll_periods pp
     where pp.company_id = v_company
       and pp.period_start = new.period_start
       and pp.published_at is not null
  ) then
    raise exception 'this payroll period is deployed — un-deploy it first to make changes';
  end if;

  new.company_id := v_company;
  new.updated_by := auth.uid();
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Deploy / un-deploy (admins only), both audit-logged.
-- ---------------------------------------------------------------------------

create or replace function public.publish_payroll_period(
  p_period_start date,
  p_period_end date
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company uuid;
begin
  if not app.is_company_admin() then
    raise exception 'only HR, operations manager, or super admin can deploy payroll';
  end if;
  v_company := app.user_company_id();
  if p_period_end < p_period_start then
    raise exception 'period_end is before period_start';
  end if;

  insert into public.payroll_periods (company_id, period_start, period_end, published_at, published_by)
  values (v_company, p_period_start, p_period_end, now(), auth.uid())
  on conflict (company_id, period_start) do update
    set published_at = now(), published_by = auth.uid(), period_end = excluded.period_end;

  insert into public.audit_logs (company_id, actor_id, action, table_name, record_id, details)
  values (v_company, auth.uid(), 'payroll_period_deployed', 'payroll_periods', p_period_start::text,
          jsonb_build_object('period_start', p_period_start, 'period_end', p_period_end));
end;
$$;

create or replace function public.unpublish_payroll_period(p_period_start date)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company uuid;
begin
  if not app.is_company_admin() then
    raise exception 'only HR, operations manager, or super admin can un-deploy payroll';
  end if;
  v_company := app.user_company_id();

  update public.payroll_periods
     set published_at = null, published_by = null
   where company_id = v_company and period_start = p_period_start;

  insert into public.audit_logs (company_id, actor_id, action, table_name, record_id, details)
  values (v_company, auth.uid(), 'payroll_period_undeployed', 'payroll_periods', p_period_start::text,
          jsonb_build_object('period_start', p_period_start));
end;
$$;

revoke all on function public.publish_payroll_period(date, date) from public;
grant execute on function public.publish_payroll_period(date, date) to authenticated;
revoke all on function public.unpublish_payroll_period(date) from public;
grant execute on function public.unpublish_payroll_period(date) to authenticated;

-- ---------------------------------------------------------------------------
-- Employee self-service: the deployed periods, and their own payslip.
-- ---------------------------------------------------------------------------

create or replace function public.my_payslip_periods()
returns table (period_start date, period_end date, published_at timestamptz)
language sql
security definer
set search_path = public
as $$
  select pp.period_start, pp.period_end, pp.published_at
  from public.payroll_periods pp
  join public.profiles me on me.id = auth.uid() and me.company_id = pp.company_id
  where pp.published_at is not null
  order by pp.period_start desc;
$$;

/*
 * One payslip for the CALLER. Returns no rows unless the period is deployed.
 *
 * NOTE: inside a security-definer function the `security_invoker` view
 * attendance_effective no longer scopes itself to the caller, so the
 * `employee_id = auth.uid()` filter below is what keeps one employee from
 * seeing another's pay. Do not remove it.
 */
create or replace function public.my_payslip(p_period_start date)
returns table (
  employee_id      uuid,
  employee_code    text,
  full_name        text,
  branch_name      text,
  date_hired       date,
  leave_remaining  numeric,
  daily_rate       numeric,
  daily_allowance  numeric,
  days_present     double precision,
  full_days        int,
  paid_leave_days  double precision,
  ot_paid_hours    int,
  ot_pay           numeric,
  period_start     date,
  period_end       date,
  add_allowance    numeric,
  holiday_pay      numeric,
  others_less      numeric,
  adjustment_less  numeric,
  cash_advance     numeric,
  sss              numeric,
  philhealth       numeric,
  pagibig          numeric,
  others           numeric
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company uuid;
  v_end     date;
begin
  select company_id into v_company from public.profiles where id = auth.uid();
  if v_company is null then
    return;
  end if;

  -- Not deployed (or not this company's period) → nothing at all.
  select pp.period_end into v_end
    from public.payroll_periods pp
   where pp.company_id = v_company
     and pp.period_start = p_period_start
     and pp.published_at is not null;
  if v_end is null then
    return;
  end if;

  return query
  select
    s.employee_id,
    s.employee_code,
    s.full_name,
    s.branch_name,
    p.date_hired,
    coalesce((
      select sum(b.remaining_days)::numeric
        from public.leave_balances_view b
       where b.employee_id = auth.uid()
         and b.year = extract(year from p_period_start)::int
    ), 0)::numeric,
    s.daily_rate,
    s.daily_allowance,
    s.days_present,
    s.full_days,
    s.paid_leave_days,
    s.ot_paid_hours,
    s.ot_pay,
    p_period_start,
    v_end,
    coalesce(pa.add_allowance, 0)::numeric,
    coalesce(pa.holiday_pay, 0)::numeric,
    coalesce(pa.others_less, 0)::numeric,
    coalesce(pa.adjustment_less, 0)::numeric,
    coalesce(pa.cash_advance, 0)::numeric,
    coalesce(pa.sss, 0)::numeric,
    coalesce(pa.philhealth, 0)::numeric,
    coalesce(pa.pagibig, 0)::numeric,
    coalesce(pa.others, 0)::numeric
  from public.report_payroll_summary(p_period_start, v_end, null) s
  join public.profiles p on p.id = s.employee_id
  left join public.payroll_adjustments pa
    on pa.employee_id = s.employee_id and pa.period_start = p_period_start
  where s.employee_id = auth.uid();
end;
$$;

revoke all on function public.my_payslip_periods() from public;
grant execute on function public.my_payslip_periods() to authenticated;
revoke all on function public.my_payslip(date) from public;
grant execute on function public.my_payslip(date) to authenticated;
