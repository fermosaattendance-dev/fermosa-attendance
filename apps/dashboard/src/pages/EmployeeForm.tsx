import {
  COMPANY_WIDE_ROLES,
  ROLE_LABELS,
  type EmploymentStatus,
  type Profile,
  type Role,
} from '@fermosa/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  createEmployee,
  generateTempPassword,
  resetMfa,
  resetPassword,
  setEmployeePin,
} from '../lib/adminApi';
import { useAuth } from '../lib/auth';
import { supabase } from '../lib/supabase';
import { STATUS_LABELS } from './Employees';

interface Option {
  id: string;
  name: string;
}

const inputClass =
  'mt-1 input';
const labelClass = 'block text-sm font-medium text-gray-700';

export function EmployeeForm() {
  const { id } = useParams();
  const isNew = !id;
  const navigate = useNavigate();
  const { profile: me } = useAuth();

  const [branches, setBranches] = useState<Option[]>([]);
  const [departments, setDepartments] = useState<Option[]>([]);
  const [positions, setPositions] = useState<Option[]>([]);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState(() => generateTempPassword());
  const [fullName, setFullName] = useState('');
  const [employeeCode, setEmployeeCode] = useState('');
  const [role, setRole] = useState<Role>('employee');
  const [branchId, setBranchId] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [positionId, setPositionId] = useState('');
  const [status, setStatus] = useState<EmploymentStatus>('active');
  const [phone, setPhone] = useState('');

  const [pin, setPin] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [loginName, setLoginName] = useState<string | null>(null);

  // Compensation — HR/admins only; the table's RLS blocks everyone else anyway.
  const isAdmin = me ? COMPANY_WIDE_ROLES.includes(me.role) : false;
  const [monthlyRate, setMonthlyRate] = useState('');
  const [dailyAllowance, setDailyAllowance] = useState('');
  const [compExists, setCompExists] = useState(false);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(isNew);

  useEffect(() => {
    supabase.from('branches').select('id, name').order('name')
      .then(({ data }) => setBranches((data as Option[]) ?? []));
    supabase.from('departments').select('id, name').order('name')
      .then(({ data }) => setDepartments((data as Option[]) ?? []));
    supabase.from('positions').select('id, name').order('name')
      .then(({ data }) => setPositions((data as Option[]) ?? []));
  }, []);

  useEffect(() => {
    if (!id) return;
    supabase.from('profiles').select('*').eq('id', id).maybeSingle()
      .then(({ data }) => {
        const p = data as Profile | null;
        if (p) {
          setFullName(p.full_name);
          setEmployeeCode(p.employee_code);
          setRole(p.role);
          setBranchId(p.branch_id ?? '');
          setDepartmentId(p.department_id ?? '');
          setPositionId(p.position_id ?? '');
          setStatus(p.employment_status);
          setPhone(p.phone ?? '');
        }
        setLoaded(true);
      });
    supabase.rpc('admin_get_login', { p_user_id: id }).then(({ data }) => {
      if (typeof data === 'string') setLoginName(data);
    });
  }, [id]);

  useEffect(() => {
    if (!id || !isAdmin) return;
    supabase
      .from('employee_compensation')
      .select('monthly_rate, daily_allowance')
      .eq('employee_id', id)
      .maybeSingle()
      .then(({ data }) => {
        if (data) {
          setMonthlyRate(String(data.monthly_rate));
          setDailyAllowance(String(data.daily_allowance));
          setCompExists(true);
        }
      });
  }, [id, isAdmin]);

  /** Upsert the pay row; returns an error message or null. Skips when nothing was entered. */
  const saveCompensation = async (employeeId: string): Promise<string | null> => {
    if (!isAdmin) return null;
    if (!compExists && monthlyRate === '' && dailyAllowance === '') return null;
    const { error: compErr } = await supabase.from('employee_compensation').upsert({
      employee_id: employeeId,
      monthly_rate: Number(monthlyRate) || 0,
      daily_allowance: Number(dailyAllowance) || 0,
    });
    if (!compErr) setCompExists(true);
    return compErr ? compErr.message : null;
  };

  const roleOptions = (Object.keys(ROLE_LABELS) as Role[]).filter(
    (r) => r !== 'super_admin' || me?.role === 'super_admin',
  );

  // Their login (auth email). Show the bare username for @fermosa.local accounts.
  const loginDisplay =
    loginName === null
      ? 'Loading…'
      : loginName.endsWith('@fermosa.local')
        ? loginName.slice(0, -'@fermosa.local'.length)
        : loginName;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);

    const username = email.trim();
    if (isNew) {
      // A username becomes <username>@fermosa.local; a real email is used as-is.
      const valid = username.includes('@')
        ? /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(username)
        : /^[a-zA-Z0-9._+-]+$/.test(username);
      if (!valid) {
        setError(
          username.includes('@')
            ? 'That email looks invalid — check the format (e.g. name@example.com).'
            : 'Username can only use letters, numbers, and . _ - (no spaces). Try e.g. mae.navarro.',
        );
        return;
      }
    }

    setBusy(true);

    if (isNew) {
      const res = await createEmployee({
        email: username,
        password,
        full_name: fullName,
        employee_code: employeeCode,
        role,
        branch_id: branchId || null,
        department_id: departmentId || null,
        position_id: positionId || null,
        employment_status: status,
        phone: phone || null,
      });
      if (!res.ok) {
        setBusy(false);
        setError(res.error ?? 'Failed to create employee');
        return;
      }
      if (res.user_id) {
        const compErr = await saveCompensation(res.user_id);
        if (compErr) {
          setBusy(false);
          setError(`Employee created, but pay was not saved (${compErr}) — open their page to set it.`);
          return;
        }
      }
      setBusy(false);
      navigate('/employees');
    } else {
      const { error: updErr } = await supabase
        .from('profiles')
        .update({
          full_name: fullName,
          employee_code: employeeCode,
          role,
          branch_id: branchId || null,
          department_id: departmentId || null,
          position_id: positionId || null,
          employment_status: status,
          phone: phone || null,
        })
        .eq('id', id);
      if (updErr) {
        setBusy(false);
        setError(updErr.message);
        return;
      }
      const compErr = await saveCompensation(id!);
      setBusy(false);
      if (compErr) {
        setError(`Saved, but pay was not updated: ${compErr}`);
        return;
      }
      setNotice('Employee updated.');
    }
  };

  const onSetPin = async () => {
    setError(null);
    setNotice(null);
    const res = await setEmployeePin(id!, pin);
    if (!res.ok) setError(res.error ?? 'Failed to set PIN');
    else {
      setNotice('PIN saved.');
      setPin('');
    }
  };

  const onResetPassword = async () => {
    setError(null);
    setNotice(null);
    const res = await resetPassword(id!, newPassword);
    if (!res.ok) setError(res.error ?? 'Failed to reset password');
    else {
      setNotice(`Password reset. Share it with the employee: ${newPassword}`);
      setNewPassword('');
    }
  };

  const onResetMfa = async () => {
    if (
      !window.confirm(
        "Remove this employee's 2FA? They will sign in with just their password until they re-enroll.",
      )
    )
      return;
    setError(null);
    setNotice(null);
    const res = await resetMfa(id!);
    if (!res.ok) setError(res.error ?? 'Failed to reset 2FA');
    else setNotice('2FA reset. The employee can set it up again from Settings.');
  };

  if (!loaded) {
    return <p className="text-sm text-gray-400">Loading…</p>;
  }

  return (
    <div className="mx-auto max-w-2xl">
      <Link to="/employees" className="text-sm text-brand-700 hover:underline">
        ← Back to employees
      </Link>
      <h2 className="mt-2 text-lg font-semibold text-ink">
        {isNew ? 'New employee' : `Edit — ${fullName}`}
      </h2>

      <form onSubmit={onSubmit} className="mt-4 space-y-4 card p-6">
        {!isNew && (
          <div>
            <label className={labelClass}>Username (their login)</label>
            <input readOnly value={loginDisplay} className={`${inputClass} bg-ground font-mono`} />
            <p className="mt-1 text-xs text-gray-500">
              What they type to sign in — read-only. Use “Reset password” below if they’re locked out.
            </p>
          </div>
        )}
        {isNew && (
          <>
            <div>
              <label className={labelClass}>Username (their login)</label>
              <input
                type="text"
                required
                autoCapitalize="none"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="e.g. maria.santos"
                className={inputClass}
              />
              <p className="mt-1 text-xs text-gray-500">
                No email needed — letters, numbers and dots only, no spaces (e.g. mae.navarro).
                A real email works too.
              </p>
            </div>
            <div>
              <label className={labelClass}>Temporary password</label>
              <div className="mt-1 flex gap-2">
                <input
                  required
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full input font-mono"
                />
                <button
                  type="button"
                  onClick={() => setPassword(generateTempPassword())}
                  className="whitespace-nowrap btn"
                >
                  Generate
                </button>
              </div>
              <p className="mt-1 text-xs text-gray-500">
                Share this with the employee in person — it is not emailed.
              </p>
            </div>
          </>
        )}

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>Full name</label>
            <input required value={fullName} onChange={(e) => setFullName(e.target.value)} className={inputClass} />
          </div>
          <div>
            <label className={labelClass}>Employee code</label>
            <input required value={employeeCode} onChange={(e) => setEmployeeCode(e.target.value)} placeholder="FSC-0007" className={inputClass} />
          </div>
          <div>
            <label className={labelClass}>Role</label>
            <select value={role} onChange={(e) => setRole(e.target.value as Role)} className={inputClass}>
              {roleOptions.map((r) => (
                <option key={r} value={r}>{ROLE_LABELS[r]}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelClass}>Employment status</label>
            <select value={status} onChange={(e) => setStatus(e.target.value as EmploymentStatus)} className={inputClass}>
              {(Object.keys(STATUS_LABELS) as EmploymentStatus[]).map((s) => (
                <option key={s} value={s}>{STATUS_LABELS[s]}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelClass}>Branch</label>
            <select value={branchId} onChange={(e) => setBranchId(e.target.value)} className={inputClass}>
              <option value="">— none (roving — picks branch at time-in) —</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
            <p className="mt-1 text-xs text-gray-500">
              No branch = roving/supervisor staff: they choose which branch they're at each time
              they time in, and the geofence checks the branch they pick.
            </p>
          </div>
          <div>
            <label className={labelClass}>Department</label>
            <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} className={inputClass}>
              <option value="">— none —</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelClass}>Position</label>
            <select value={positionId} onChange={(e) => setPositionId(e.target.value)} className={inputClass}>
              <option value="">— none —</option>
              {positions.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelClass}>Phone</label>
            <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+63 9xx xxx xxxx" className={inputClass} />
          </div>
        </div>

        {isAdmin && (
          <div className="border-t border-gray-100 pt-4">
            <h3 className="text-sm font-semibold text-gray-900">Compensation</h3>
            <p className="mt-1 text-xs text-gray-500">
              Visible to HR and admins only. The allowance is paid per <strong>full</strong> day
              present — a half-day (late past the half-day mark) earns no allowance.
            </p>
            <div className="mt-3 grid grid-cols-2 gap-4">
              <div>
                <label className={labelClass}>Monthly salary rate (₱)</label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  inputMode="decimal"
                  value={monthlyRate}
                  onChange={(e) => setMonthlyRate(e.target.value)}
                  placeholder="0.00"
                  className={inputClass}
                />
              </div>
              <div>
                <label className={labelClass}>Allowance per full day (₱)</label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  inputMode="decimal"
                  value={dailyAllowance}
                  onChange={(e) => setDailyAllowance(e.target.value)}
                  placeholder="0.00"
                  className={inputClass}
                />
              </div>
            </div>
          </div>
        )}

        {error && <p className="text-sm text-red-600">{error}</p>}
        {notice && <p className="text-sm text-green-700">{notice}</p>}

        <button
          type="submit"
          disabled={busy}
          className="btn-primary"
        >
          {busy ? 'Saving…' : isNew ? 'Create employee' : 'Save changes'}
        </button>
      </form>

      {!isNew && (
        <div className="mt-6 grid grid-cols-2 gap-4">
          <div className="card p-5">
            <h3 className="text-sm font-semibold text-gray-900">Kiosk PIN</h3>
            <p className="mt-1 text-xs text-gray-500">4–6 digits, used on shared branch tablets.</p>
            <div className="mt-3 flex gap-2">
              <input
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="1234"
                inputMode="numeric"
                className="w-full input font-mono"
              />
              <button
                type="button"
                onClick={onSetPin}
                disabled={pin.length < 4}
                className="whitespace-nowrap btn"
              >
                Set PIN
              </button>
            </div>
          </div>

          <div className="card p-5">
            <h3 className="text-sm font-semibold text-gray-900">Reset password</h3>
            <p className="mt-1 text-xs text-gray-500">Give the new password to the employee directly.</p>
            <div className="mt-3 flex gap-2">
              <input
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="New password"
                className="w-full input font-mono"
              />
              <button
                type="button"
                onClick={onResetPassword}
                disabled={newPassword.length < 8}
                className="whitespace-nowrap btn"
              >
                Reset
              </button>
            </div>
          </div>

          {me?.role === 'super_admin' && (
            <div className="card p-5">
              <h3 className="text-sm font-semibold text-gray-900">Reset 2FA</h3>
              <p className="mt-1 text-xs text-gray-500">
                Clear this employee’s authenticator if they lost their device. They sign in with
                their password until they re-enroll.
              </p>
              <button
                type="button"
                onClick={onResetMfa}
                className="mt-3 whitespace-nowrap btn"
              >
                Reset 2FA
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
