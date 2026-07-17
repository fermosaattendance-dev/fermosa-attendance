-- Birthday leave = a fixed 1-day perk usable on ANY single day in the birth month
-- (user, 2026-07-17: "you can choose 1 day from July 1 to July 31"). Unlike regular
-- leave it is NOT reduced by rest days / holidays — so a birthday that falls on (or a
-- chosen day that is) a non-working day still counts as the 1 day. Redefine
-- tg_leave_prepare to set day_count = 1 for birthday_only types after validation.

create or replace function app.tg_leave_prepare()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company uuid;
  v_birthday date;
  v_birthday_only boolean;
begin
  select company_id, birthday into v_company, v_birthday
    from public.profiles where id = new.employee_id;
  if v_company is null then
    raise exception 'employee not found';
  end if;
  new.company_id := v_company;
  if new.end_date < new.start_date then
    raise exception 'end date must be on or after start date';
  end if;
  if new.half_day and new.start_date <> new.end_date then
    raise exception 'half-day leave must be a single day';
  end if;

  select birthday_only into v_birthday_only
    from public.leave_types where id = new.leave_type_id;
  if coalesce(v_birthday_only, false) then
    if v_birthday is null then
      raise exception 'birthday leave requires your birth date on file — ask HR to add it';
    end if;
    if new.start_date <> new.end_date then
      raise exception 'birthday leave is a single day';
    end if;
    if extract(month from new.start_date) <> extract(month from v_birthday) then
      raise exception 'birthday leave can only be taken during your birth month';
    end if;
    -- Fixed 1-day perk: any day in the birth month, rest days/holidays included.
    new.day_count := 1;
    return new;
  end if;

  new.day_count := app.leave_day_count(new.employee_id, new.start_date, new.end_date, new.half_day);
  return new;
end;
$$;
