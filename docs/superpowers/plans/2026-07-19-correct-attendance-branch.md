# Correct the branch on an attendance day — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let HR / super-admin fix a misclicked branch on Reviews → Correct — re-attributing the day (and the shift it's measured against) to the correct branch, audit-logged, with the raw punches left as evidence.

**Architecture:** One new admin-only Postgres RPC (`correct_attendance_branch`) updates `attendance_records.branch_id` (+ the pinned shift) and recomputes the day against the new branch; the raw `attendance_events` are untouched. The Reviews Correct form gains a Branch selector (pre-filled) and, for multi-shift branches, a Shift picker; on Save it calls the new RPC (when branch/shift changed) then the existing `review_attendance('corrected', …)`. Payroll/reports need no change — they already group by the record's branch.

**Tech Stack:** Supabase Postgres (plpgsql, SECURITY DEFINER RPC), React + TypeScript (Vite dashboard), `@fermosa/shared` helpers (`branchShifts`, `formatShift`, `computeDayMinutes`).

**Spec:** [docs/superpowers/specs/2026-07-19-correct-attendance-branch-design.md](../specs/2026-07-19-correct-attendance-branch-design.md)

## Global Constraints

- **Node not on PATH.** Prefix every node/npm Bash call with `export PATH="/c/Users/mai/AppData/Local/Programs/nodejs:$PATH"`.
- **Prod `db push` is gated.** Applying the migration to production requires an explicit AskUserQuestion approval naming the production target, then re-running the identical `npx supabase db push` command. It uses the **DB password rotated 2026-07-19** (ask the user).
- **Scenario scripts need a current Supabase access token** (ask the user each session; never echo it). Service-role key is fetched at runtime from `https://api.supabase.com/v1/projects/lvoqvkbydbkyyaxonzmp/api-keys?reveal=true` with the token.
- **Migration filename:** `supabase/migrations/20260806000001_correct_attendance_branch.sql` (next after `20260805000001`).
- **Access:** RPC gated to `app.is_company_admin()` (hr / operations_manager / super_admin); branch managers stay view-only. Reason required.
- **Punches immutable:** only the day record's `branch_id` + shift change; `attendance_events` are never modified.
- **Audit action:** `attendance_branch_corrected`.
- **Time-string compare:** Postgres `time` values arrive as `'HH:MM:SS'`; normalize with `.slice(0, 5)` before comparing to avoid `'12:00'` vs `'12:00:00'` mismatches.
- **Post-commit hook auto-pushes** `main` to the new repo → Vercel auto-deploys. No manual push needed.

---

## Task 1: Backend RPC + shared audit label

**Files:**
- Create: `supabase/migrations/20260806000001_correct_attendance_branch.sql`
- Modify: `packages/shared/src/constants.ts:65` (add one label after `attendance_day_created`)
- Test (scratchpad, not committed): `C:\Users\mai\AppData\Local\Temp\claude\D--Attedance-apps\d93495aa-a275-4107-a491-dfa2455223ca\scratchpad\correct-branch-test.mjs`

**Interfaces:**
- Produces: `public.correct_attendance_branch(p_record_id uuid, p_branch_id uuid, p_shift_start time default null, p_shift_end time default null, p_note text default null) returns void` — admin-only; updates the record's branch + shift, recomputes, audits `attendance_branch_corrected`. Consumed by Task 2's `saveCorrection`.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260806000001_correct_attendance_branch.sql`:

```sql
-- Correct the branch on an attendance day (pilot feedback 2026-07-19). Roving /
-- supervisor staff pick their branch at time-in and sometimes MISCLICK. The
-- wrong branch on the day's attendance_records row drives payroll rollup, which
-- manager can review it (RLS), and which shift late/OT is measured against.
-- This lets HR/super-admin re-attribute the DAY to the correct branch (+ the
-- shift the person was on), audit-logged. Raw punches (attendance_events) stay
-- untouched as evidence — same principle as Void/Correct acting on the day, not
-- the punches. Recompute runs against coalesce(record.shift, branch.shift), so
-- updating branch_id + shift_start/shift_end and calling compute is sufficient.

create or replace function public.correct_attendance_branch(
  p_record_id uuid,
  p_branch_id uuid,
  p_shift_start time default null,
  p_shift_end time default null,
  p_note text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.attendance_records%rowtype;
  b public.branches%rowtype;
  v_old_branch uuid;
begin
  if not app.is_company_admin() then
    raise exception 'only HR, operations manager, or super admin can correct the branch';
  end if;
  if p_note is null or btrim(p_note) = '' then
    raise exception 'a reason is required to correct the branch';
  end if;

  select * into r from public.attendance_records
   where id = p_record_id and company_id = app.user_company_id();
  if r.id is null then
    raise exception 'attendance day not found in your company';
  end if;

  select * into b from public.branches
   where id = p_branch_id and company_id = r.company_id and is_active = true;
  if b.id is null then
    raise exception 'branch not found (or inactive) in your company';
  end if;

  -- A chosen shift must be one the branch actually defines (Shift 1/2/3).
  if p_shift_start is not null then
    if not (
      (p_shift_start = b.shift_start and p_shift_end = b.shift_end)
      or (b.shift2_start is not null and p_shift_start = b.shift2_start and p_shift_end = b.shift2_end)
      or (b.shift3_start is not null and p_shift_start = b.shift3_start and p_shift_end = b.shift3_end)
    ) then
      raise exception 'invalid shift for this branch';
    end if;
  end if;

  v_old_branch := r.branch_id;

  update public.attendance_records
     set branch_id = p_branch_id,
         shift_start = p_shift_start,
         shift_end = p_shift_end
   where id = p_record_id;

  -- Refresh base columns (day_class, computed late/OT) against the new branch/
  -- shift. HR's minute overrides are applied afterward via review_attendance.
  perform app.compute_attendance_record(p_record_id);

  insert into public.audit_logs (company_id, actor_id, action, table_name, record_id, details)
  values (
    r.company_id, auth.uid(), 'attendance_branch_corrected', 'attendance_records',
    p_record_id::text,
    jsonb_build_object(
      'old_branch_id', v_old_branch, 'new_branch_id', p_branch_id,
      'shift_start', p_shift_start, 'shift_end', p_shift_end, 'note', p_note
    )
  );
end;
$$;

revoke all on function public.correct_attendance_branch(uuid, uuid, time, time, text) from public;
grant execute on function public.correct_attendance_branch(uuid, uuid, time, time, text) to authenticated;
```

- [ ] **Step 2: Add the shared audit label**

In `packages/shared/src/constants.ts`, after the `attendance_day_created` line (65), add:

```ts
  attendance_branch_corrected: 'Attendance branch corrected',
```

- [ ] **Step 3: Build shared + typecheck**

Run:
```bash
export PATH="/c/Users/mai/AppData/Local/Programs/nodejs:$PATH"
cd "D:/Attedance apps" && npm run build -w packages/shared && npm run typecheck -w apps/dashboard
```
Expected: both succeed (the label is a plain map entry; dashboard picks up the rebuilt shared package).

- [ ] **Step 4: Apply the migration to production (GATED)**

Ask the user via AskUserQuestion to approve the production `db push` (name the target: Supabase project `lvoqvkbydbkyyaxonzmp`). On approval, run the identical command (DB password = the one rotated 2026-07-19):
```bash
export PATH="/c/Users/mai/AppData/Local/Programs/nodejs:$PATH"
cd "D:/Attedance apps" && npx supabase db push
```
Expected: the one new migration `20260806000001_correct_attendance_branch` applies cleanly.

- [ ] **Step 5: Write the scenario script**

Ask the user for a current Supabase **access token**. Create the scratchpad script `correct-branch-test.mjs`:

```js
// Verify correct_attendance_branch end-to-end on the live DB. Env: ACCESS_TOKEN.
import { createClient } from '@supabase/supabase-js';
const REF = 'lvoqvkbydbkyyaxonzmp';
const URL = `https://${REF}.supabase.co`;
const keys = await (await fetch(`https://api.supabase.com/v1/projects/${REF}/api-keys?reveal=true`, {
  headers: { Authorization: `Bearer ${process.env.ACCESS_TOKEN}` },
})).json();
const SERVICE = keys.find((k) => k.name === 'service_role').api_key;
const ANON = keys.find((k) => k.name === 'anon').api_key;
const db = createClient(URL, SERVICE, { auth: { persistSession: false } });

const made = { branches: [], users: [] };
const fail = (m) => { console.error('FAIL:', m); process.exitCode = 1; };
const ok = (m) => console.log('ok  ', m);

try {
  const { data: company } = await db.from('companies').select('id').limit(1).single();
  const cid = company.id;

  // Temp branch X (single shift 09:00-18:00) and Y (Shift 1 08:00-17:00 + Shift 2 12:00-21:00).
  const mkBranch = async (name, cols) => {
    const { data, error } = await db.from('branches').insert({
      company_id: cid, name, lat: 14.4, lng: 120.9, geofence_radius_m: 100,
      timezone: 'Asia/Manila', is_active: true, work_days: [1,2,3,4,5,6], ...cols,
    }).select('id').single();
    if (error) throw error;
    made.branches.push(data.id);
    return data.id;
  };
  const X = await mkBranch('ZZ Test X', { shift_start: '09:00', shift_end: '18:00' });
  const Y = await mkBranch('ZZ Test Y', { shift_start: '08:00', shift_end: '17:00', shift2_start: '12:00', shift2_end: '21:00' });

  // Temp roving employee + temp HR, both with passwords so we can sign in.
  const mkUser = async (username, role) => {
    const email = `${username}@fermosa.local`;
    const { data } = await db.auth.admin.createUser({ email, password: 'Test#2026x', email_confirm: true });
    made.users.push(data.user.id);
    await db.from('profiles').insert({
      id: data.user.id, company_id: cid, branch_id: null,
      employee_code: username.toUpperCase().slice(0, 8), full_name: username, role,
      employment_status: 'active',
    });
    return { id: data.user.id, email };
  };
  const emp = await mkUser('zz.rov', 'employee');
  const hr = await mkUser('zz.hr', 'hr');

  // Seed a day at X: clock in 09:05, clock out 18:00 (single shift → late ~0 vs 09:00).
  const day = '2026-07-10';
  const punch = (type, hhmm, branch) => db.rpc('ingest_punch_as', {
    p_employee_id: emp.id, p_client_uuid: crypto.randomUUID(), p_type: type,
    p_happened_at: `${day}T${hhmm}:00+08:00`, p_branch_id: branch, p_source: 'web',
  });
  await punch('clock_in', '12:05', X); // 12:05 vs X's 09:00 start = ~3h late (proves the bug)
  await punch('clock_out', '21:00', X);

  const recOf = async () => (await db.from('attendance_records')
    .select('id, branch_id, shift_start, late_minutes, status')
    .eq('employee_id', emp.id).eq('work_date', day).single()).data;
  let rec = await recOf();
  if (rec.branch_id !== X) fail('day did not pin to X'); else ok('day pinned to X');
  if (rec.late_minutes < 150) fail(`expected big late vs X 09:00, got ${rec.late_minutes}`);
  else ok(`late vs X = ${rec.late_minutes}m (the misclick symptom)`);

  // HR client (user-scoped, so app.is_company_admin() sees the HR role).
  const hrDb = createClient(URL, ANON, { auth: { persistSession: false } });
  await hrDb.auth.signInWithPassword({ email: hr.email, password: 'Test#2026x' });
  const empDb = createClient(URL, ANON, { auth: { persistSession: false } });
  await empDb.auth.signInWithPassword({ email: emp.email, password: 'Test#2026x' });

  // Correct to branch Y, Shift 2 (12:00-21:00) → late should drop to ~0.
  let { error } = await hrDb.rpc('correct_attendance_branch', {
    p_record_id: rec.id, p_branch_id: Y, p_shift_start: '12:00', p_shift_end: '21:00', p_note: 'wrong branch tapped',
  });
  if (error) fail(`HR correct failed: ${error.message}`); else ok('HR corrected branch → Y shift2');
  rec = await recOf();
  if (rec.branch_id !== Y) fail('branch_id not updated to Y'); else ok('branch_id = Y');
  if (rec.shift_start?.slice(0,5) !== '12:00') fail(`shift not pinned to 12:00, got ${rec.shift_start}`);
  else ok('shift pinned to 12:00');
  if (rec.late_minutes > 5) fail(`expected ~0 late vs 12:00, got ${rec.late_minutes}`);
  else ok(`late vs Y shift2 = ${rec.late_minutes}m (fixed)`);

  // Payroll rolls the day under Y.
  const { data: summ } = await hrDb.rpc('report_payroll_summary', { p_from: day, p_to: day, p_branch_id: Y });
  if ((summ ?? []).some((row) => row.employee_id === emp.id)) ok('payroll rolls the day under Y');
  else fail('day not found under Y in payroll summary');

  // Error paths.
  ({ error } = await empDb.rpc('correct_attendance_branch', { p_record_id: rec.id, p_branch_id: X, p_shift_start: null, p_shift_end: null, p_note: 'x' }));
  if (error) ok(`non-admin rejected: ${error.message}`); else fail('employee was allowed to correct');
  ({ error } = await hrDb.rpc('correct_attendance_branch', { p_record_id: rec.id, p_branch_id: crypto.randomUUID(), p_shift_start: null, p_shift_end: null, p_note: 'x' }));
  if (error) ok('bogus branch rejected'); else fail('bogus branch accepted');
  ({ error } = await hrDb.rpc('correct_attendance_branch', { p_record_id: rec.id, p_branch_id: Y, p_shift_start: '10:00', p_shift_end: '19:00', p_note: 'x' }));
  if (error) ok('invalid shift rejected'); else fail('invalid shift accepted');
  ({ error } = await hrDb.rpc('correct_attendance_branch', { p_record_id: rec.id, p_branch_id: Y, p_shift_start: null, p_shift_end: null, p_note: '  ' }));
  if (error) ok('blank note rejected'); else fail('blank note accepted');

  // Audit row written.
  const { data: audit } = await db.from('audit_logs').select('id')
    .eq('action', 'attendance_branch_corrected').eq('record_id', rec.id).limit(1);
  if (audit?.length) ok('audit row attendance_branch_corrected written'); else fail('no audit row');
} finally {
  // Cleanup (FK-safe: events/records before profiles/users; branches last).
  for (const uid of made.users) {
    await db.from('attendance_events').delete().eq('employee_id', uid);
    await db.from('attendance_records').delete().eq('employee_id', uid);
    await db.from('profiles').delete().eq('id', uid);
    await db.auth.admin.deleteUser(uid).catch(() => {});
  }
  for (const bid of made.branches) await db.from('branches').delete().eq('id', bid);
  console.log('cleaned up');
}
```

- [ ] **Step 6: Run the scenario script**

Run (paste the token inline; never commit it):
```bash
export PATH="/c/Users/mai/AppData/Local/Programs/nodejs:$PATH"
cd "D:/Attedance apps" && ACCESS_TOKEN="<token>" node "C:/Users/mai/AppData/Local/Temp/claude/D--Attedance-apps/d93495aa-a275-4107-a491-dfa2455223ca/scratchpad/correct-branch-test.mjs"
```
Expected: every line prefixed `ok`, ending `cleaned up`, exit code 0. Any `FAIL:` → fix the migration and re-run (the migration is `create or replace`, so re-`db push` after edits).

- [ ] **Step 7: Commit**

```bash
cd "D:/Attedance apps" && git add supabase/migrations/20260806000001_correct_attendance_branch.sql packages/shared/src/constants.ts && git commit -m "$(cat <<'EOF'
feat: correct_attendance_branch RPC (HR fixes a misclicked branch)

Admin-only RPC re-attributes an attendance day to the correct branch +
shift and recomputes late/OT against it; audit-logged. Punches untouched.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```
Expected: commit + post-commit auto-push to `main`.

---

## Task 2: Reviews Correct — Branch + Shift pickers

**Files:**
- Modify: `apps/dashboard/src/pages/Reviews.tsx` (import, `RecordRow`, `FilterOption`, branches load, record load, `saveCorrection`, `CorrectionForm`, its render)

**Interfaces:**
- Consumes: `public.correct_attendance_branch(...)` from Task 1; `branchShifts` + `formatShift` from `@fermosa/shared`.
- Produces: none (leaf UI).

- [ ] **Step 1: Import `branchShifts`**

In `apps/dashboard/src/pages/Reviews.tsx`, add `branchShifts` to the `@fermosa/shared` import (line 1-9):

```ts
import {
  PUNCH_LABELS,
  REVIEWER_ROLES,
  branchShifts,
  computeDayMinutes,
  punchWindowForWorkDate,
  type AttendanceStatus,
  type PunchSource,
  type PunchType,
} from '@fermosa/shared';
```

- [ ] **Step 2: Add `branch_id` to `RecordRow`**

In the `RecordRow` interface, after `shift_end: string | null;` (line 35), add:

```ts
  branch_id: string | null;
```

- [ ] **Step 3: Extend `FilterOption` with shift 2/3 columns**

In the `FilterOption` interface (lines 553-561), after `shift_end?: string;`, add:

```ts
  shift2_start?: string | null; // branches: multi-shift (for the Correct picker)
  shift2_end?: string | null;
  shift3_start?: string | null;
  shift3_end?: string | null;
```

- [ ] **Step 4: Load the shift 2/3 columns on branches**

Change the branches load select (line 597) from `'id, name, shift_start, shift_end'` to:

```ts
      .select('id, name, shift_start, shift_end, shift2_start, shift2_end, shift3_start, shift3_end')
```

- [ ] **Step 5: Select `branch_id` on the record query**

In the `load` query select string (line 618), add `branch_id,` — e.g. change `flags, corrections, shift_start, shift_end, employee:` to:

```
flags, corrections, shift_start, shift_end, branch_id, employee:
```

- [ ] **Step 6: Add the `saveCorrection` helper**

Immediately after the `review` function (after line 657), add:

```ts
  // Save a Correct: apply a branch/shift change first (if any), then the
  // time/minute correction. Two audited steps; both surface errors inline.
  const saveCorrection = async (
    id: string,
    note: string,
    corrections: Record<string, number | string>,
    branchChange: { branchId: string; shiftStart: string; shiftEnd: string } | null,
  ) => {
    setError(null);
    if (branchChange) {
      const { error: brErr } = await supabase.rpc('correct_attendance_branch', {
        p_record_id: id,
        p_branch_id: branchChange.branchId,
        p_shift_start: branchChange.shiftStart,
        p_shift_end: branchChange.shiftEnd,
        p_note: note,
      });
      if (brErr) {
        setError(brErr.message);
        return;
      }
    }
    await review(id, 'corrected', note, corrections);
  };
```

- [ ] **Step 7: Replace `CorrectionForm` with the branch/shift-aware version**

Replace the entire `CorrectionForm` function (lines 226-362) with:

```tsx
/**
 * Time-based correction (2026-07-16) + branch correction (2026-07-19):
 * HR enters the actual Time in / Time out; minute overrides recompute with the
 * engine's rules (computeDayMinutes) against the day's shift. Changing Branch
 * (roving/supervisor misclick) re-measures against that branch's hours — with a
 * Shift picker when the branch runs 2-3 shifts — and persists via
 * correct_attendance_branch. Late / Undertime / OT stay hand-editable.
 */
function CorrectionForm({
  record,
  branches,
  settings,
  onSave,
  onCancel,
}: {
  record: RecordRow;
  branches: FilterOption[];
  settings: EngineSettings;
  onSave: (
    note: string,
    corrections: Record<string, number | string>,
    branchChange: { branchId: string; shiftStart: string; shiftEnd: string } | null,
  ) => void;
  onCancel: () => void;
}) {
  const [inTime, setInTime] = useState(() => {
    const t = effectiveTime(record, 'first_in');
    return t ? timeInputFmt.format(new Date(t)) : '';
  });
  const [outTime, setOutTime] = useState(() => {
    const t = effectiveTime(record, 'last_out');
    return t ? timeInputFmt.format(new Date(t)) : '';
  });
  const [note, setNote] = useState('');
  const [lateMin, setLateMin] = useState('');
  const [undertimeMin, setUndertimeMin] = useState('');
  const [otMin, setOtMin] = useState('');

  // Branch + shift the day is attributed to (fix a roving/supervisor misclick).
  const [branchId, setBranchId] = useState(record.branch_id ?? '');
  const selectedBranch = branches.find((b) => b.id === branchId) ?? null;
  const shiftOptions =
    selectedBranch?.shift_start && selectedBranch.shift_end
      ? branchShifts({
          shift_start: selectedBranch.shift_start,
          shift_end: selectedBranch.shift_end,
          shift2_start: selectedBranch.shift2_start,
          shift2_end: selectedBranch.shift2_end,
          shift3_start: selectedBranch.shift3_start,
          shift3_end: selectedBranch.shift3_end,
        })
      : [];
  // Default the shift index to the record's pinned shift (same branch), else 0.
  const [shiftIdx, setShiftIdx] = useState(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (branchId === record.branch_id && record.shift_start) {
      const i = shiftOptions.findIndex((o) => o.start.slice(0, 5) === record.shift_start!.slice(0, 5));
      setShiftIdx(i >= 0 ? i : 0);
    } else {
      setShiftIdx(0);
    }
  }, [branchId]);

  const chosenShift = shiftOptions[shiftIdx] ?? null;
  const shiftStart = chosenShift?.start ?? record.shift_start ?? record.branch?.shift_start ?? '00:00';
  const shiftEnd = chosenShift?.end ?? record.shift_end ?? record.branch?.shift_end ?? '00:00';

  const inIso = inTime ? new Date(`${record.work_date}T${inTime}:00+08:00`).toISOString() : null;
  let outIso = outTime ? new Date(`${record.work_date}T${outTime}:00+08:00`).toISOString() : null;
  if (inIso && outIso && Date.parse(outIso) <= Date.parse(inIso)) {
    outIso = new Date(Date.parse(outIso) + 24 * 3_600_000).toISOString();
  }

  let minutes = null;
  if (inIso && outIso) {
    minutes = computeDayMinutes({
      workDate: record.work_date,
      shiftStart,
      shiftEnd,
      firstInIso: inIso,
      lastOutIso: outIso,
      punchedBreakMin: record.break_minutes ?? 0,
      lateGraceMin: settings.late_grace_min,
      otThresholdMin: settings.ot_threshold_min,
      minBreakMin: settings.min_break_min,
    });
    if (minutes && !selectedBranch) {
      minutes = { ...minutes, late_minutes: 0, undertime_minutes: 0, overtime_minutes: 0 };
    }
  }

  // Re-sync editable minutes to the computed values when times / branch / shift change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (minutes) {
      setLateMin(String(minutes.late_minutes));
      setUndertimeMin(String(minutes.undertime_minutes));
      setOtMin(String(minutes.overtime_minutes));
    }
  }, [inIso, outIso, branchId, shiftIdx]);

  const clampMin = (v: string) => Math.max(0, Math.round(Number(v) || 0));

  // Persist a branch/shift change when the branch differs, or the chosen shift
  // differs from what the record currently uses.
  const norm = (t: string | null | undefined) => (t ? t.slice(0, 5) : null);
  const currentStart = record.shift_start ?? record.branch?.shift_start ?? null;
  const currentEnd = record.shift_end ?? record.branch?.shift_end ?? null;
  const branchChanged =
    !!branchId &&
    (branchId !== record.branch_id ||
      (chosenShift != null &&
        (norm(chosenShift.start) !== norm(currentStart) || norm(chosenShift.end) !== norm(currentEnd))));

  return (
    <div className="border-t border-gray-200 bg-amber-50 px-4 py-3">
      <p className="text-xs font-semibold text-amber-800">
        Correct this day — enter the actual times; Late / Undertime / OT default to the computed
        values, edit them to waive or grant (e.g. set Late to 0 to excuse a late). Change Branch to
        fix a roving/supervisor misclick — Late/OT re-measure against that branch's hours.
      </p>
      <div className="mt-2 flex flex-wrap items-end gap-3">
        <label className="text-xs text-gray-600">
          Branch
          <select value={branchId} onChange={(e) => setBranchId(e.target.value)} className="mt-1 block input">
            <option value="">— select branch —</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
        </label>
        {shiftOptions.length > 1 && (
          <label className="text-xs text-gray-600">
            Shift
            <select value={shiftIdx} onChange={(e) => setShiftIdx(Number(e.target.value))} className="mt-1 block input">
              {shiftOptions.map((o, i) => (
                <option key={i} value={i}>{o.label}</option>
              ))}
            </select>
          </label>
        )}
        <label className="text-xs text-gray-600">
          Time in
          <input type="time" value={inTime} onChange={(e) => setInTime(e.target.value)} className="mt-1 block input" />
        </label>
        <label className="text-xs text-gray-600">
          Time out
          <input type="time" value={outTime} onChange={(e) => setOutTime(e.target.value)} className="mt-1 block input" />
        </label>
        <label className="w-24 text-xs text-gray-600">
          Late (min)
          <input type="number" min={0} value={lateMin} onChange={(e) => setLateMin(e.target.value)} className="mt-1 block w-full input" />
        </label>
        <label className="w-28 text-xs text-gray-600">
          Undertime (min)
          <input type="number" min={0} value={undertimeMin} onChange={(e) => setUndertimeMin(e.target.value)} className="mt-1 block w-full input" />
        </label>
        <label className="w-24 text-xs text-gray-600">
          OT (min)
          <input type="number" min={0} value={otMin} onChange={(e) => setOtMin(e.target.value)} className="mt-1 block w-full input" />
        </label>
        <label className="min-w-64 flex-1 text-xs text-gray-600">
          Reason (required)
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. wrong branch tapped — confirmed with branch manager"
            className="mt-1 block w-full input" />
        </label>
        <button
          onClick={() => {
            if (!minutes || !inIso || !outIso) return;
            onSave(
              note,
              {
                first_in: inIso,
                last_out: outIso,
                worked_minutes: minutes.worked_minutes,
                break_minutes: minutes.break_minutes,
                late_minutes: clampMin(lateMin),
                undertime_minutes: clampMin(undertimeMin),
                overtime_minutes: clampMin(otMin),
              },
              branchChanged && chosenShift
                ? { branchId, shiftStart: chosenShift.start, shiftEnd: chosenShift.end }
                : null,
            );
          }}
          disabled={!note.trim() || !minutes}
          className="btn-primary"
        >
          Save correction
        </button>
        <button onClick={onCancel} className="btn">
          Cancel
        </button>
      </div>
      <p className="mt-2 text-xs text-amber-800">
        {minutes
          ? `→ worked ${fmtMinutes(minutes.worked_minutes)} · late ${clampMin(lateMin)}m · undertime ${clampMin(undertimeMin)}m · OT ${clampMin(otMin)}m (break ${minutes.break_minutes}m deducted)`
          : 'Enter the time in and time out (out must be after in).'}
      </p>
    </div>
  );
}
```

- [ ] **Step 8: Pass `branches` + the new `onSave` into `CorrectionForm`**

In the render (lines 870-876), update the `CorrectionForm` element:

```tsx
                      <CorrectionForm
                        record={r}
                        branches={branches}
                        settings={engineSettings}
                        onSave={(note, corrections, branchChange) =>
                          void saveCorrection(r.id, note, corrections, branchChange)
                        }
                        onCancel={() => setCorrectId(null)}
                      />
```

- [ ] **Step 9: Typecheck**

Run:
```bash
export PATH="/c/Users/mai/AppData/Local/Programs/nodejs:$PATH"
cd "D:/Attedance apps" && npm run typecheck -w apps/dashboard && npm test -w packages/shared
```
Expected: typecheck clean; shared tests still pass (no shared logic changed beyond the label).

- [ ] **Step 10: Browser verification**

Start the dashboard dev server (MCP `preview_start name:dashboard`), sign in as an HR/super-admin, open **Reviews**, and (using an existing branch that has a Shift 2, or after setting one on the Branches page) confirm:
1. Open **Correct** on a day → the **Branch** dropdown is pre-filled with the day's branch.
2. Change to a 2-shift branch → the **Shift** picker appears; picking a shift updates the "→ late …" preview.
3. Save with a reason → the row flips to **Corrected**, moves under the chosen branch (filter Reviews by that branch to confirm), and the punches remain in the day detail.
4. A **time-only** Correct (no branch change) still works exactly as before (no `correct_attendance_branch` call — confirm via network tab or that a non-reviewer/regular day is unaffected).

Capture a screenshot of the Correct panel showing the Branch + Shift pickers.

- [ ] **Step 11: Commit**

```bash
cd "D:/Attedance apps" && git add apps/dashboard/src/pages/Reviews.tsx && git commit -m "$(cat <<'EOF'
feat: correct the branch on Reviews -> Correct

Branch dropdown (pre-filled) + Shift picker for multi-shift branches on
the Correct panel; re-measures late/OT against the chosen branch and
persists via correct_attendance_branch. Punches stay as evidence.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```
Expected: commit + auto-push → Vercel auto-deploy. Confirm the deploy with a bundle-grep for a new string (e.g. `re-measure against that branch`).

---

## Self-Review

**Spec coverage:**
- Branch selector on Correct for any employee, pre-filled → Task 2 Steps 2, 5, 7 (`branchId` defaults to `record.branch_id`; dropdown always renders). ✓
- Recompute Late/OT vs new branch; Shift picker for 2-3 shifts → Task 2 Step 7 (`shiftOptions`, `computeDayMinutes` on chosen shift) + Task 1 (`compute_attendance_record` after update). ✓
- Punches untouched → Task 1 RPC touches only `attendance_records` + `audit_logs`. ✓
- HR/super-admin only, reason required → Task 1 `is_company_admin()` + note guard. ✓
- Audit-logged from→to branch → Task 1 `attendance_branch_corrected` details; Task 1 Step 2 label. ✓
- Payroll/reports unchanged → no change (group-by-record-branch already). ✓
- Branch-manager punch-visibility limitation → documented in spec; no code needed. ✓

**Placeholder scan:** none — every step has concrete code/commands.

**Type consistency:** `branchChange: { branchId; shiftStart; shiftEnd }` is identical in `CorrectionForm.onSave` (Step 7), the render (Step 8), and `saveCorrection` (Step 6). `correct_attendance_branch` param names (`p_record_id/p_branch_id/p_shift_start/p_shift_end/p_note`) match between Task 1 SQL and Task 2 `saveCorrection`. `branchShifts` input shape matches the shared helper. ✓

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-19-correct-attendance-branch.md`. Two execution options:

1. **Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute the two tasks in this session with checkpoints for review.

Which approach?
