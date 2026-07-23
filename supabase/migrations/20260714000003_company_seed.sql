-- Seed the company row up front. Later migrations (attendance_engine's
-- attendance_settings default row, holidays, leave types) reference this fixed
-- id and fail on a fresh replay if no company exists — the original deployment
-- only worked because seed.sql / the bulk importer had created the row first.
-- Name must match the bulk importer's COMPANY_NAME default so it finds this
-- row instead of creating a second company.
insert into public.companies (id, name)
values ('c0000000-0000-0000-0000-000000000001', 'Fermosa Skin Care Clinic')
on conflict do nothing;
