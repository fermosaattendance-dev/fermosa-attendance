// payroll-sync — push a pay period's approved payroll summary to Google Sheets.
//
// The browser never holds Google credentials or the service_role key. This
// function verifies the caller's JWT, requires an admin role, and re-fetches the
// payroll rows through the caller's own session (so RLS scopes them to the
// caller's company). It writes one tab per pay period and overwrites it on
// re-sync (idempotent). Without Google secrets — or when the client asks for a
// dry run — it skips Google and returns a preview, logging the attempt either
// way in public.payroll_syncs.

import { createClient } from 'jsr:@supabase/supabase-js@2';

type Role = 'employee' | 'branch_manager' | 'hr' | 'operations_manager' | 'super_admin';
const ADMIN_ROLES: Role[] = ['hr', 'operations_manager', 'super_admin'];

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

// Read the `aal` claim from the caller's already-validated JWT.
function jwtAal(authHeader: string): string | null {
  const token = authHeader.replace(/^Bearer\s+/i, '');
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    return (JSON.parse(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '='))).aal as string) ?? null;
  } catch {
    return null;
  }
}

// If the caller has a verified 2FA factor, require a stepped-up (aal2) session.
function mfaSatisfied(caller: { factors?: { status?: string }[] } | null, authHeader: string): boolean {
  const hasVerified = (caller?.factors ?? []).some((f) => f.status === 'verified');
  return !hasVerified || jwtAal(authHeader) === 'aal2';
}

const HEADERS = [
  'Employee code', 'Name', 'Branch', 'Days present', 'Full days', 'Days absent', 'Worked hours',
  'Late (min)', 'Undertime (min)', 'OT (min)', 'OT hrs (paid)', 'Paid leave', 'Unpaid leave',
  'Rest-days worked', 'Holidays worked', 'Daily rate', 'Allowance/full day', 'Late charge', 'OT pay',
];

interface PayrollRow {
  employee_code: string;
  full_name: string;
  branch_name: string;
  days_present: number;
  full_days: number;
  days_absent: number;
  worked_minutes: number;
  late_minutes: number;
  undertime_minutes: number;
  overtime_minutes: number;
  paid_leave_days: number;
  unpaid_leave_days: number;
  rest_days_worked: number;
  holidays_worked: number;
  daily_rate: number | null;
  daily_allowance: number | null;
  late_charge: number | null;
  ot_paid_hours: number;
  ot_pay: number | null;
}

function toValues(rows: PayrollRow[]): (string | number)[][] {
  const body = rows.map((r) => [
    r.employee_code, r.full_name, r.branch_name, r.days_present, r.full_days, r.days_absent,
    Number((r.worked_minutes / 60).toFixed(2)), r.late_minutes, r.undertime_minutes,
    r.overtime_minutes, r.ot_paid_hours, r.paid_leave_days, r.unpaid_leave_days, r.rest_days_worked, r.holidays_worked,
    r.daily_rate ?? '', r.daily_allowance ?? '', r.late_charge ?? '', r.ot_pay ?? '',
  ]);
  return [HEADERS, ...body];
}

// --- Google service-account auth (Web Crypto RS256 JWT → OAuth token) ---

function b64url(input: Uint8Array | string): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemToDer(pem: string): ArrayBuffer {
  const b64 = pem.replace(/-----BEGIN [^-]+-----/, '').replace(/-----END [^-]+-----/, '').replace(/\s+/g, '');
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function getGoogleAccessToken(email: string, privateKeyPem: string, scope: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(
    JSON.stringify({ iss: email, scope, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }),
  );
  const signingInput = `${header}.${claim}`;
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToDer(privateKeyPem.replace(/\\n/g, '\n')),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(signingInput)));
  const assertion = `${signingInput}.${b64url(sig)}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Google token error: ${data.error_description ?? data.error ?? res.status}`);
  return data.access_token as string;
}

async function pushToSheet(
  token: string,
  sheetId: string,
  tab: string,
  values: (string | number)[][],
): Promise<void> {
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}`;
  const auth = { Authorization: `Bearer ${token}` };

  // Ensure the period tab exists.
  const metaRes = await fetch(`${base}?fields=sheets.properties.title`, { headers: auth });
  const meta = await metaRes.json();
  if (!metaRes.ok) throw new Error(`Sheets read error: ${meta.error?.message ?? metaRes.status}`);
  const exists = (meta.sheets ?? []).some((s: { properties?: { title?: string } }) => s.properties?.title === tab);
  if (!exists) {
    const addRes = await fetch(`${base}:batchUpdate`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title: tab } } }] }),
    });
    if (!addRes.ok) throw new Error(`Sheets addSheet error: ${(await addRes.json()).error?.message ?? addRes.status}`);
  }

  // Overwrite: clear then write (idempotent per period).
  const range = encodeURIComponent(`'${tab}'`);
  const clearRes = await fetch(`${base}/values/${range}:clear`, { method: 'POST', headers: auth });
  if (!clearRes.ok) throw new Error(`Sheets clear error: ${(await clearRes.json()).error?.message ?? clearRes.status}`);

  const writeRange = encodeURIComponent(`'${tab}'!A1`);
  const putRes = await fetch(`${base}/values/${writeRange}?valueInputOption=RAW`, {
    method: 'PUT',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values }),
  });
  if (!putRes.ok) throw new Error(`Sheets write error: ${(await putRes.json()).error?.message ?? putRes.status}`);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json(405, { ok: false, error: 'method not allowed' });

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;

  const authHeader = req.headers.get('Authorization') ?? '';
  const callerClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
  const {
    data: { user: caller },
  } = await callerClient.auth.getUser();
  if (!caller) return json(401, { ok: false, error: 'not authenticated' });

  const admin = createClient(supabaseUrl, serviceKey);
  const { data: callerProfile } = await admin
    .from('profiles')
    .select('company_id, role')
    .eq('id', caller.id)
    .maybeSingle();
  if (!callerProfile || !ADMIN_ROLES.includes(callerProfile.role as Role)) {
    return json(403, { ok: false, error: 'admin role required' });
  }
  if (!mfaSatisfied(caller, authHeader)) {
    return json(403, { ok: false, error: '2FA required: complete two-factor sign-in before this action' });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json(400, { ok: false, error: 'invalid JSON body' });
  }

  const periodStart = String(body.period_start ?? '');
  const periodEnd = String(body.period_end ?? '');
  const branchId = (body.branch_id as string | null) || null;
  const sheetTab = String(body.sheet_tab ?? '').trim() || `${periodStart}..${periodEnd}`;
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRe.test(periodStart) || !dateRe.test(periodEnd)) {
    return json(400, { ok: false, error: 'period_start and period_end must be YYYY-MM-DD' });
  }

  // Re-fetch the payroll rows as the caller (RLS scopes to their company).
  const { data: rowsData, error: rpcErr } = await callerClient.rpc('report_payroll_summary', {
    p_from: periodStart,
    p_to: periodEnd,
    p_branch_id: branchId,
  });
  if (rpcErr) return json(400, { ok: false, error: rpcErr.message });
  const rows = (rowsData ?? []) as PayrollRow[];
  const values = toValues(rows);
  const checksum = await sha256Hex(JSON.stringify(values));

  const sheetId = Deno.env.get('PAYROLL_SHEET_ID') ?? '';
  const saEmail = Deno.env.get('GOOGLE_SA_EMAIL') ?? '';
  const saKey = Deno.env.get('GOOGLE_SA_PRIVATE_KEY') ?? '';
  const haveGoogle = Boolean(sheetId && saEmail && saKey);
  const dryRun = body.dry_run === true || !haveGoogle;

  const logSync = (status: string, error: string | null) =>
    admin.from('payroll_syncs').insert({
      company_id: callerProfile.company_id,
      period_start: periodStart,
      period_end: periodEnd,
      branch_id: branchId,
      sheet_id: dryRun ? null : sheetId,
      sheet_tab: sheetTab,
      row_count: rows.length,
      checksum,
      status,
      error,
      synced_by: caller.id,
    });

  if (dryRun) {
    await logSync('dry_run', null);
    return json(200, {
      ok: true,
      dryRun: true,
      reason: body.dry_run === true ? 'requested' : 'google credentials not configured',
      tab: sheetTab,
      rowCount: rows.length,
      checksum,
      preview: values,
    });
  }

  try {
    const token = await getGoogleAccessToken(saEmail, saKey, 'https://www.googleapis.com/auth/spreadsheets');
    await pushToSheet(token, sheetId, sheetTab, values);
    await logSync('synced', null);
    return json(200, { ok: true, dryRun: false, tab: sheetTab, rowCount: rows.length, checksum });
  } catch (e) {
    const msg = (e as Error).message;
    await logSync('failed', msg);
    return json(500, { ok: false, error: msg });
  }
});
