-- Payslip manual amounts (pilot request 2026-07-20).
--
-- Everything else on a payslip is already computed: report_payroll_summary
-- gives days_present (half-day rule applied), full_days, paid_leave_days,
-- daily_rate, daily_allowance and ot_pay; profiles.date_hired and
-- leave_balances_view supply the header lines. What has nowhere to live are
-- the NINE amounts HR sets per employee per pay period — the columns from
-- their payroll spreadsheet.
--
-- HR fills these for the whole company in one Excel sheet and uploads it once
-- (the dashboard generates the template pre-filled with employee codes, so
-- rows match on code, never on a free-text name). Inline edits on a single
-- payslip write to the same row.
--
-- Money → admin-only, like employee_compensation: RLS is row-level and branch
-- managers / employees can read profile rows, so these amounts cannot live on
-- profiles. One policy, company admins only.

-- ---------------------------------------------------------------------------
-- Table: one row per employee per pay period.
-- ---------------------------------------------------------------------------

create table public.payroll_adjustments (
  employee_id     uuid not null references public.profiles (id) on delete cascade,
  period_start    date not null,
  period_end      date not null,
  company_id      uuid not null references public.companies (id) on delete cascade,

  -- Additions
  add_allowance   numeric(10,2) not null default 0 check (add_allowance   >= 0),
  holiday_pay     numeric(10,2) not null default 0 check (holiday_pay     >= 0),
  -- Deducted before the sub-total
  others_less     numeric(10,2) not null default 0 check (others_less     >= 0),
  adjustment_less numeric(10,2) not null default 0 check (adjustment_less >= 0),
  -- Deducted after the sub-total
  cash_advance    numeric(10,2) not null default 0 check (cash_advance    >= 0),
  sss             numeric(10,2) not null default 0 check (sss             >= 0),
  philhealth      numeric(10,2) not null default 0 check (philhealth      >= 0),
  pagibig         numeric(10,2) not null default 0 check (pagibig         >= 0),
  others          numeric(10,2) not null default 0 check (others          >= 0),

  note            text,
  updated_by      uuid references public.profiles (id) on delete set null,
  updated_at      timestamptz not null default now(),

  -- One row per employee per period: an upload re-run updates, never duplicates.
  primary key (employee_id, period_start)
);

create index payroll_adjustments_company_period_idx
  on public.payroll_adjustments (company_id, period_start desc);

alter table public.payroll_adjustments enable row level security;

-- The ONLY policy: company admins. Branch managers and employees get nothing.
create policy payroll_adjustments_admin on public.payroll_adjustments
  for all to authenticated
  using (company_id = app.user_company_id() and app.is_company_admin())
  with check (company_id = app.user_company_id() and app.is_company_admin());

-- ---------------------------------------------------------------------------
-- Prepare trigger: company_id always comes from the target employee's profile
-- (client value ignored); stamp who/when. Runs as the caller, so RLS on
-- profiles makes a cross-company employee_id resolve to "not found".
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
  new.company_id := v_company;
  new.updated_by := auth.uid();
  new.updated_at := now();
  return new;
end;
$$;

create trigger payroll_adjustments_prepare
  before insert or update on public.payroll_adjustments
  for each row execute function app.tg_payroll_adjustments_prepare();

-- ---------------------------------------------------------------------------
-- Audit trigger: every amount change lands in audit_logs (admin-only read).
-- security definer so it can insert despite the admin-only policy.
-- ---------------------------------------------------------------------------

create or replace function app.tg_audit_payroll_adjustments()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old jsonb;
  v_new jsonb;
begin
  v_new := jsonb_build_object(
    'add_allowance', new.add_allowance, 'holiday_pay', new.holiday_pay,
    'others_less', new.others_less, 'adjustment_less', new.adjustment_less,
    'cash_advance', new.cash_advance, 'sss', new.sss,
    'philhealth', new.philhealth, 'pagibig', new.pagibig, 'others', new.others
  );
  v_old := case when tg_op = 'UPDATE' then jsonb_build_object(
    'add_allowance', old.add_allowance, 'holiday_pay', old.holiday_pay,
    'others_less', old.others_less, 'adjustment_less', old.adjustment_less,
    'cash_advance', old.cash_advance, 'sss', old.sss,
    'philhealth', old.philhealth, 'pagibig', old.pagibig, 'others', old.others
  ) else null end;

  if tg_op = 'INSERT' or v_old is distinct from v_new then
    insert into public.audit_logs (company_id, actor_id, action, table_name, record_id, details)
    values (
      new.company_id,
      auth.uid(),
      'payroll_adjustment_set',
      'payroll_adjustments',
      new.employee_id::text,
      jsonb_build_object('period_start', new.period_start, 'old', v_old, 'new', v_new)
    );
  end if;
  return new;
end;
$$;

create trigger payroll_adjustments_audit
  after insert or update on public.payroll_adjustments
  for each row execute function app.tg_audit_payroll_adjustments();
