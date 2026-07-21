-- Self-service kiosk PIN (2026-07-21).
--
-- set_employee_pin (20260714000002) is admin-only. This lets an employee set /
-- change their OWN kiosk PIN from their dashboard. It always targets auth.uid(),
-- so no one can set another person's PIN through it. Employees can't write
-- profiles directly (profiles_write_admin is admin-only), so this SECURITY
-- DEFINER RPC is the only self-serve path.

create or replace function public.set_my_pin(p_pin text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  if p_pin !~ '^[0-9]{4,6}$' then
    raise exception 'PIN must be 4-6 digits';
  end if;

  update public.profiles
     set pin_hash = extensions.crypt(p_pin, extensions.gen_salt('bf'))
   where id = auth.uid();

  insert into public.audit_logs (company_id, actor_id, action, table_name, record_id)
  values (app.user_company_id(), auth.uid(), 'pin_set', 'profiles', auth.uid()::text);
end;
$$;

revoke all on function public.set_my_pin(text) from public;
grant execute on function public.set_my_pin(text) to authenticated;
