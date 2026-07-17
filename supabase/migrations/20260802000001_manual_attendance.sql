-- HR manual time entry (user request, 2026-07-17): let HR/super-admin record a
-- day for an employee who never punched (emergency, dead phone, forgot to time
-- out). Design: punches (attendance_events) stay untouched as evidence — the
-- manual entry lives on the DAY RECORD as an audited correction. This RPC only
-- guarantees the attendance_records row EXISTS (computing it as absent when no
-- punches); the dashboard then applies the actual times via the existing
-- review_attendance('corrected', note, {first_in, last_out, ...minutes}) flow,
-- which attendance_effective + payroll already honor.

create or replace function public.create_attendance_record(
  p_employee_id uuid,
  p_work_date date,
  p_branch_id uuid default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.profiles%rowtype;
  v_branch_id uuid;
  v_id uuid;
begin
  if not app.is_company_admin() then
    raise exception 'only HR, operations manager, or super admin can create attendance days';
  end if;

  select * into v_profile
    from public.profiles
   where id = p_employee_id
     and company_id = app.user_company_id();
  if v_profile.id is null then
    raise exception 'employee not found in your company';
  end if;

  v_branch_id := coalesce(p_branch_id, v_profile.branch_id);
  if v_branch_id is null then
    raise exception 'no branch: pick the branch this employee worked at';
  end if;
  if not exists (
    select 1 from public.branches b
     where b.id = v_branch_id and b.company_id = v_profile.company_id
  ) then
    raise exception 'branch not found in your company';
  end if;

  insert into public.attendance_records (company_id, employee_id, branch_id, work_date)
  values (v_profile.company_id, v_profile.id, v_branch_id, p_work_date)
  on conflict (employee_id, work_date) do nothing;

  select id into v_id
    from public.attendance_records
   where employee_id = v_profile.id and work_date = p_work_date;

  -- Zero-punch days compute cleanly (absent / on_leave flags).
  perform app.compute_attendance_record(v_id);

  insert into public.audit_logs (company_id, actor_id, action, table_name, record_id, details)
  values (
    v_profile.company_id, auth.uid(), 'attendance_day_created', 'attendance_records',
    v_id::text,
    jsonb_build_object('employee_id', v_profile.id, 'work_date', p_work_date, 'branch_id', v_branch_id)
  );

  return v_id;
end;
$$;

revoke all on function public.create_attendance_record(uuid, date, uuid) from public;
grant execute on function public.create_attendance_record(uuid, date, uuid) to authenticated;
