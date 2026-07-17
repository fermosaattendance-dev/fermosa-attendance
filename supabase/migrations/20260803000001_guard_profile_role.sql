-- Security hardening (2026-07-17): close a privilege-escalation gap.
--
-- The `profiles_write_admin` RLS policy (20260714000001_identity.sql) lets any
-- company admin (hr / operations_manager / super_admin) UPDATE any profile in
-- their company. That is correct for normal management, BUT with no further
-- guard it also lets an HR/ops admin set role = 'super_admin' — on someone else
-- OR on themselves — by a direct PostgREST update, bypassing the "only a super
-- admin can grant super_admin" check that lives only in the admin-users Edge
-- Function. This trigger enforces that rule at the database level (defense in
-- depth) so the guard can no longer be sidestepped.
--
-- Rules on a role change (before update):
--   1. No one may change THEIR OWN role (no self-escalation, no self-demotion).
--   2. Granting or removing the super_admin role requires the actor to be a
--      super_admin — mirroring the Edge Function's create-time check.
-- HR/ops may still assign employee / branch_manager / hr / operations_manager
-- (unchanged from today), so normal staff management is unaffected.
--
-- Service-role callers (bulk importer, Edge Functions) have no JWT, so
-- auth.uid() is null and the trigger steps aside — those paths are already
-- trusted and gated in their own code.

create or replace function app.tg_guard_profile_role()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_actor_role public.user_role;
begin
  -- Only inspect real role changes.
  if new.role is not distinct from old.role then
    return new;
  end if;

  -- No JWT (service role: bulk import, admin Edge Functions) → not RLS-scoped,
  -- already trusted. Leave untouched.
  if v_actor is null then
    return new;
  end if;

  select role into v_actor_role from public.profiles where id = v_actor;

  -- 1. Never change your own role.
  if new.id = v_actor then
    raise exception 'you cannot change your own role';
  end if;

  -- 2. The super_admin tier is granted/removed by super admins only.
  if (new.role = 'super_admin' or old.role = 'super_admin')
     and coalesce(v_actor_role, 'employee'::public.user_role) <> 'super_admin' then
    raise exception 'only a super admin can grant or remove the super admin role';
  end if;

  return new;
end;
$$;

create trigger profiles_guard_role
  before update on public.profiles
  for each row execute function app.tg_guard_profile_role();
