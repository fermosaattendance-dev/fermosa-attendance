import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { TwoFactorCard } from '../components/TwoFactorCard';
import { useAuth } from '../lib/auth';
import { supabase } from '../lib/supabase';

interface HolidayRow {
  id: string;
  holiday_date: string;
  name: string;
  kind: 'regular' | 'special';
}

interface LeaveTypeRow {
  id: string;
  name: string;
  is_paid: boolean;
  default_days_per_year: number;
  is_active: boolean;
}

const inputClass =
  'mt-1 input';
const labelClass = 'block text-sm font-medium text-gray-700';

export function Settings() {
  const { profile } = useAuth();
  const [grace, setGrace] = useState('15');
  const [otThreshold, setOtThreshold] = useState('30');
  const [minBreak, setMinBreak] = useState('60');
  const [holidays, setHolidays] = useState<HolidayRow[]>([]);
  const [hDate, setHDate] = useState('');
  const [hName, setHName] = useState('');
  const [hKind, setHKind] = useState<'regular' | 'special'>('regular');
  const [leaveTypes, setLeaveTypes] = useState<LeaveTypeRow[]>([]);
  const [ltName, setLtName] = useState('');
  const [ltPaid, setLtPaid] = useState(true);
  const [ltDays, setLtDays] = useState('5');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    supabase.from('attendance_settings').select('*').maybeSingle().then(({ data }) => {
      if (data) {
        setGrace(String(data.late_grace_min));
        setOtThreshold(String(data.ot_threshold_min));
        setMinBreak(String(data.min_break_min));
      }
    });
    supabase.from('holidays').select('id, holiday_date, name, kind').order('holiday_date')
      .then(({ data }) => setHolidays((data as HolidayRow[]) ?? []));
    supabase.from('leave_types').select('id, name, is_paid, default_days_per_year, is_active').order('name')
      .then(({ data }) => setLeaveTypes((data as LeaveTypeRow[]) ?? []));
  }, []);

  useEffect(load, [load]);

  const saveSettings = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    const { error: err } = await supabase
      .from('attendance_settings')
      .update({
        late_grace_min: Number(grace),
        ot_threshold_min: Number(otThreshold),
        min_break_min: Number(minBreak),
      })
      .eq('company_id', profile!.company_id);
    if (err) setError(err.message);
    else setNotice('Settings saved. They apply to punches computed from now on; use Recompute on a review if a past day needs the new rules.');
  };

  const addHoliday = async () => {
    setError(null);
    if (!hDate || !hName.trim()) return;
    const { error: err } = await supabase.from('holidays').insert({
      company_id: profile!.company_id,
      holiday_date: hDate,
      name: hName.trim(),
      kind: hKind,
    });
    if (err) setError(err.message);
    else {
      setHDate('');
      setHName('');
      load();
    }
  };

  const removeHoliday = async (h: HolidayRow) => {
    if (!window.confirm(`Remove "${h.name}" (${h.holiday_date})?`)) return;
    const { error: err } = await supabase.from('holidays').delete().eq('id', h.id);
    if (err) setError(err.message);
    else load();
  };

  const addLeaveType = async () => {
    setError(null);
    if (!ltName.trim()) return;
    const days = Number(ltDays);
    if (Number.isNaN(days) || days < 0) {
      setError('Days per year must be a non-negative number.');
      return;
    }
    const { error: err } = await supabase.from('leave_types').insert({
      company_id: profile!.company_id,
      name: ltName.trim(),
      is_paid: ltPaid,
      default_days_per_year: days,
    });
    if (err) setError(err.message);
    else {
      setLtName('');
      setLtDays('5');
      setLtPaid(true);
      load();
    }
  };

  const updateLeaveType = async (t: LeaveTypeRow, patch: Partial<LeaveTypeRow>) => {
    setError(null);
    const { error: err } = await supabase.from('leave_types').update(patch).eq('id', t.id);
    if (err) setError(err.message);
    else load();
  };

  const grantEntitlements = async () => {
    setError(null);
    setNotice(null);
    const year = new Date().getFullYear();
    if (!window.confirm(`Create ${year} leave balances for all active employees from each type's default? Existing balances are kept.`)) return;
    const { data, error: err } = await supabase.rpc('grant_leave_entitlements', { p_year: year });
    if (err) setError(err.message);
    else setNotice(`Granted ${data} new balance row(s) for ${year}. Adjust individuals on the Leave → Balances tab.`);
  };

  return (
    <div className="mx-auto max-w-3xl">
      <h2 className="text-lg font-semibold text-ink">Attendance settings</h2>
      <p className="text-sm text-gray-500">Company-wide rules the engine applies to every punch.</p>

      <form onSubmit={saveSettings} className="mt-4 card p-6">
        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className={labelClass}>Late grace (minutes)</label>
            <input type="number" min={0} max={120} value={grace} onChange={(e) => setGrace(e.target.value)} className={inputClass} />
            <p className="mt-1 text-xs text-gray-500">Clock-ins within this window after shift start are on time.</p>
          </div>
          <div>
            <label className={labelClass}>OT threshold (minutes)</label>
            <input type="number" min={0} max={240} value={otThreshold} onChange={(e) => setOtThreshold(e.target.value)} className={inputClass} />
            <p className="mt-1 text-xs text-gray-500">Time past shift end must exceed this before overtime counts.</p>
          </div>
          <div>
            <label className={labelClass}>Minimum break (minutes)</label>
            <input type="number" min={0} max={240} value={minBreak} onChange={(e) => setMinBreak(e.target.value)} className={inputClass} />
            <p className="mt-1 text-xs text-gray-500">Deducted on days over 5 hours even without break punches.</p>
          </div>
        </div>
        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
        {notice && <p className="mt-3 text-sm text-green-700">{notice}</p>}
        <button type="submit" className="mt-4 btn-primary">
          Save settings
        </button>
      </form>

      <h3 className="mt-8 text-base font-semibold text-gray-900">Holidays</h3>
      <p className="text-sm text-gray-500">
        Days here are classified as holiday work (no absent marks). Regular holidays and special
        non-working days are tracked separately for payroll.
      </p>

      <div className="mt-3 flex items-end gap-3 card p-4">
        <div>
          <label className={labelClass}>Date</label>
          <input type="date" value={hDate} onChange={(e) => setHDate(e.target.value)} className={inputClass} />
        </div>
        <div className="flex-1">
          <label className={labelClass}>Name</label>
          <input value={hName} onChange={(e) => setHName(e.target.value)} placeholder="e.g. Barangay fiesta (branch closure)" className={inputClass} />
        </div>
        <div>
          <label className={labelClass}>Kind</label>
          <select value={hKind} onChange={(e) => setHKind(e.target.value as 'regular' | 'special')} className={inputClass}>
            <option value="regular">Regular holiday</option>
            <option value="special">Special non-working</option>
          </select>
        </div>
        <button onClick={addHoliday} disabled={!hDate || !hName.trim()}
          className="btn-primary">
          Add
        </button>
      </div>

      <div className="mt-3 overflow-hidden card">
        <table className="w-full text-left text-sm">
          <tbody className="divide-y divide-gray-100">
            {holidays.map((h) => (
              <tr key={h.id} className="hover:bg-gray-50">
                <td className="w-32 px-4 py-2 text-gray-900">{h.holiday_date}</td>
                <td className="px-4 py-2 text-gray-700">{h.name}</td>
                <td className="px-4 py-2">
                  <span className={h.kind === 'regular'
                    ? 'rounded-full bg-purple-100 px-2 py-0.5 text-xs text-purple-700'
                    : 'rounded-full bg-sky-100 px-2 py-0.5 text-xs text-sky-700'}>
                    {h.kind === 'regular' ? 'Regular' : 'Special'}
                  </span>
                </td>
                <td className="px-4 py-2 text-right">
                  <button onClick={() => removeHoliday(h)} className="text-sm text-gray-500 hover:underline">
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-8 flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold text-gray-900">Leave types</h3>
          <p className="text-sm text-gray-500">
            Paid types carry an annual entitlement; unpaid types have no balance. HR approves leave on the
            Leave page.
          </p>
        </div>
        <button
          onClick={grantEntitlements}
          className="rounded-lg border border-brand-300 px-3 py-2 text-sm font-medium text-brand-700 hover:bg-brand-50"
        >
          Grant {new Date().getFullYear()} entitlements
        </button>
      </div>

      <div className="mt-3 flex items-end gap-3 card p-4">
        <div className="flex-1">
          <label className={labelClass}>Name</label>
          <input value={ltName} onChange={(e) => setLtName(e.target.value)} placeholder="e.g. Bereavement" className={inputClass} />
        </div>
        <div>
          <label className={labelClass}>Days / year</label>
          <input type="number" min={0} step="0.5" value={ltDays} onChange={(e) => setLtDays(e.target.value)} className={`${inputClass} w-28`} />
        </div>
        <label className="mb-2 flex items-center gap-2 text-sm text-gray-700">
          <input type="checkbox" checked={ltPaid} onChange={(e) => setLtPaid(e.target.checked)} />
          Paid
        </label>
        <button onClick={addLeaveType} disabled={!ltName.trim()}
          className="btn-primary">
          Add
        </button>
      </div>

      <div className="mt-3 overflow-hidden card">
        <table className="w-full text-left text-sm">
          <thead className="bg-ground text-muted">
            <tr>
              <th className="px-4 py-2 font-medium">Type</th>
              <th className="px-4 py-2 font-medium">Paid</th>
              <th className="px-4 py-2 font-medium">Days / year</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {leaveTypes.map((t) => (
              <tr key={t.id} className={t.is_active ? 'hover:bg-gray-50' : 'bg-gray-50 text-gray-400'}>
                <td className="px-4 py-2 font-medium text-gray-900">{t.name}</td>
                <td className="px-4 py-2">
                  <span className={t.is_paid
                    ? 'rounded-full bg-green-100 px-2 py-0.5 text-xs text-green-700'
                    : 'rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500'}>
                    {t.is_paid ? 'Paid' : 'Unpaid'}
                  </span>
                </td>
                <td className="px-4 py-2">
                  <input
                    type="number" min={0} step="0.5" defaultValue={t.default_days_per_year}
                    onBlur={(e) => {
                      const v = Number(e.target.value);
                      if (!Number.isNaN(v) && v >= 0 && v !== t.default_days_per_year) {
                        updateLeaveType(t, { default_days_per_year: v });
                      }
                    }}
                    className="w-20 input"
                  />
                </td>
                <td className="px-4 py-2 text-xs">{t.is_active ? 'Active' : 'Inactive'}</td>
                <td className="px-4 py-2 text-right">
                  <button
                    onClick={() => updateLeaveType(t, { is_active: !t.is_active })}
                    className="text-sm text-gray-500 hover:underline"
                  >
                    {t.is_active ? 'Deactivate' : 'Reactivate'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <TwoFactorCard />
    </div>
  );
}
