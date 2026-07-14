import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useAuth } from '../lib/auth';
import { supabase } from '../lib/supabase';

interface HolidayRow {
  id: string;
  holiday_date: string;
  name: string;
  kind: 'regular' | 'special';
}

const inputClass =
  'mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none';
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

  return (
    <div className="mx-auto max-w-3xl">
      <h2 className="text-lg font-semibold text-gray-900">Attendance settings</h2>
      <p className="text-sm text-gray-500">Company-wide rules the engine applies to every punch.</p>

      <form onSubmit={saveSettings} className="mt-4 rounded-xl border border-gray-200 bg-white p-6">
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
        <button type="submit" className="mt-4 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700">
          Save settings
        </button>
      </form>

      <h3 className="mt-8 text-base font-semibold text-gray-900">Holidays</h3>
      <p className="text-sm text-gray-500">
        Days here are classified as holiday work (no absent marks). Regular holidays and special
        non-working days are tracked separately for payroll.
      </p>

      <div className="mt-3 flex items-end gap-3 rounded-xl border border-gray-200 bg-white p-4">
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
          className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50">
          Add
        </button>
      </div>

      <div className="mt-3 overflow-hidden rounded-xl border border-gray-200 bg-white">
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
    </div>
  );
}
