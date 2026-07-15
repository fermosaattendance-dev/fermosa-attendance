-- M9: Payroll → Google Sheets sync (Phase 9).
-- A log of payroll pushes to Google Sheets. The push itself runs in the
-- payroll-sync Edge Function; this table records each attempt (period, branch,
-- destination tab, row count, checksum, status) so re-syncs are auditable and
-- idempotent per period. Writes come from the Edge Function via the service
-- role (which bypasses RLS); company admins can read their own company's log.

create table public.payroll_syncs (
  id uuid primary key default uuid_generate_v4(),
  company_id uuid not null references public.companies (id),
  period_start date not null,
  period_end date not null,
  branch_id uuid references public.branches (id), -- null = all branches in scope
  sheet_id text,
  sheet_tab text not null,
  row_count int not null default 0,
  checksum text,
  status text not null default 'synced' check (status in ('synced', 'dry_run', 'failed')),
  error text,
  synced_by uuid references public.profiles (id),
  synced_at timestamptz not null default now()
);

create index payroll_syncs_company_period_idx
  on public.payroll_syncs (company_id, period_start desc);

alter table public.payroll_syncs enable row level security;

-- Company admins (hr / operations_manager / super_admin) read their own
-- company's sync log. No insert/update policy: the Edge Function writes with the
-- service role, so all writes go through server-side code, never the client.
create policy payroll_syncs_select_admin on public.payroll_syncs
  for select using (app.is_company_admin() and company_id = app.user_company_id());

grant select on public.payroll_syncs to authenticated;
