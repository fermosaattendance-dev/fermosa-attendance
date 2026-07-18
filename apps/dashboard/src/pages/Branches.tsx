import {
  DEFAULT_GEOFENCE_RADIUS_M,
  DEFAULT_TIMEZONE,
  formatShift,
  isOvernight,
  type Branch,
} from '@fermosa/shared';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useAuth } from '../lib/auth';
import { supabase } from '../lib/supabase';

const inputClass =
  'mt-1 input';
const labelClass = 'block text-sm font-medium text-gray-700';

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']; // ISO 1..7

const emptyForm = {
  name: '',
  address: '',
  lat: '',
  lng: '',
  geofence_radius_m: String(DEFAULT_GEOFENCE_RADIUS_M),
  timezone: DEFAULT_TIMEZONE,
  is_active: true,
  shift_start: '10:00',
  shift_end: '19:00',
  shift2_start: '', // blank = single-shift branch
  shift2_end: '',
  work_days: [1, 2, 3, 4, 5, 6] as number[],
};

export function Branches() {
  const { profile } = useAuth();
  const [branches, setBranches] = useState<Branch[]>([]);
  const [editingId, setEditingId] = useState<string | 'new' | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [recompute, setRecompute] = useState<{ branch: Branch; from: string; to: string } | null>(null);
  const [recomputeMsg, setRecomputeMsg] = useState<string | null>(null);
  const [recomputeBusy, setRecomputeBusy] = useState(false);

  const reload = useCallback(() => {
    supabase.from('branches').select('*').order('name')
      .then(({ data }) => setBranches((data as Branch[]) ?? []));
  }, []);

  useEffect(reload, [reload]);

  const startNew = () => {
    setEditingId('new');
    setForm(emptyForm);
    setError(null);
  };

  const startEdit = (b: Branch) => {
    setEditingId(b.id);
    setForm({
      name: b.name,
      address: b.address ?? '',
      lat: String(b.lat),
      lng: String(b.lng),
      geofence_radius_m: String(b.geofence_radius_m),
      timezone: b.timezone,
      is_active: b.is_active,
      shift_start: b.shift_start.slice(0, 5),
      shift_end: b.shift_end.slice(0, 5),
      shift2_start: b.shift2_start?.slice(0, 5) ?? '',
      shift2_end: b.shift2_end?.slice(0, 5) ?? '',
      work_days: b.work_days ?? [1, 2, 3, 4, 5, 6],
    });
    setError(null);
  };

  const toggleDay = (day: number) => {
    setForm((f) => ({
      ...f,
      work_days: f.work_days.includes(day)
        ? f.work_days.filter((d) => d !== day)
        : [...f.work_days, day].sort(),
    }));
  };

  const startRecompute = (b: Branch) => {
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const today = new Date();
    setRecompute({
      branch: b,
      from: iso(new Date(today.getTime() - 30 * 86_400_000)),
      to: iso(today),
    });
    setRecomputeMsg(null);
  };

  const runRecompute = async () => {
    if (!recompute) return;
    setRecomputeBusy(true);
    setRecomputeMsg(null);
    const { data, error: err } = await supabase.rpc('recompute_branch_attendance', {
      p_branch_id: recompute.branch.id,
      p_from: recompute.from,
      p_to: recompute.to,
    });
    setRecomputeBusy(false);
    setRecomputeMsg(
      err
        ? `Error: ${err.message}`
        : `Recomputed ${data} pending day(s) for ${recompute.branch.name}.`,
    );
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const payload = {
      name: form.name.trim(),
      address: form.address.trim() || null,
      lat: Number(form.lat),
      lng: Number(form.lng),
      geofence_radius_m: Number(form.geofence_radius_m),
      timezone: form.timezone.trim() || DEFAULT_TIMEZONE,
      is_active: form.is_active,
      shift_start: form.shift_start,
      shift_end: form.shift_end,
      shift2_start: form.shift2_start || null,
      shift2_end: form.shift2_end || null,
      work_days: form.work_days,
    };
    if (form.work_days.length === 0) {
      setError('Select at least one working day.');
      setBusy(false);
      return;
    }
    if (form.shift_start === form.shift_end) {
      setError('Shift start and end cannot be the same. For an overnight shift, set an end time earlier than the start (e.g. 22:00 → 06:00).');
      setBusy(false);
      return;
    }
    if (Boolean(form.shift2_start) !== Boolean(form.shift2_end)) {
      setError('Shift 2 needs both a start and an end — or leave both blank for a single-shift branch.');
      setBusy(false);
      return;
    }
    if (form.shift2_start && form.shift2_start === form.shift2_end) {
      setError('Shift 2 start and end cannot be the same.');
      setBusy(false);
      return;
    }
    if (Number.isNaN(payload.lat) || Number.isNaN(payload.lng)) {
      setError('Latitude and longitude must be numbers (e.g. 14.2818, 120.8656).');
      setBusy(false);
      return;
    }

    const result =
      editingId === 'new'
        ? await supabase.from('branches').insert({ ...payload, company_id: profile!.company_id })
        : await supabase.from('branches').update(payload).eq('id', editingId!);

    setBusy(false);
    if (result.error) {
      setError(result.error.message);
      return;
    }
    setEditingId(null);
    reload();
  };

  return (
    <div className="mx-auto max-w-4xl">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-ink">Branches</h2>
          <p className="text-sm text-gray-500">
            Coordinates + radius define each branch&apos;s clock-in geofence.
          </p>
        </div>
        <button
          onClick={startNew}
          className="btn-primary"
        >
          New branch
        </button>
      </div>

      {editingId && (
        <form onSubmit={onSubmit} className="mt-4 card p-6">
          <h3 className="text-sm font-semibold text-gray-900">
            {editingId === 'new' ? 'New branch' : 'Edit branch'}
          </h3>
          <div className="mt-3 grid grid-cols-2 gap-4">
            <div>
              <label className={labelClass}>Name</label>
              <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>Address</label>
              <input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>Latitude</label>
              <input required value={form.lat} onChange={(e) => setForm({ ...form, lat: e.target.value })} placeholder="14.2818" className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>Longitude</label>
              <input required value={form.lng} onChange={(e) => setForm({ ...form, lng: e.target.value })} placeholder="120.8656" className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>Geofence radius (meters, 10–5000)</label>
              <input required type="number" min={10} max={5000} value={form.geofence_radius_m} onChange={(e) => setForm({ ...form, geofence_radius_m: e.target.value })} className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>Timezone</label>
              <input value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>Shift start</label>
              <input type="time" value={form.shift_start} onChange={(e) => setForm({ ...form, shift_start: e.target.value })} className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>Shift end</label>
              <input type="time" value={form.shift_end} onChange={(e) => setForm({ ...form, shift_end: e.target.value })} className={inputClass} />
              {form.shift_start !== form.shift_end && isOvernight(form.shift_start, form.shift_end) && (
                <p className="mt-1 text-xs font-medium text-indigo-600">
                  Ends the next day (+1) — overnight shift. Late/overtime and the work day follow the day the shift starts.
                </p>
              )}
            </div>
            <div>
              <label className={labelClass}>Shift 2 start (optional)</label>
              <input type="time" value={form.shift2_start} onChange={(e) => setForm({ ...form, shift2_start: e.target.value })} className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>Shift 2 end (optional)</label>
              <input type="time" value={form.shift2_end} onChange={(e) => setForm({ ...form, shift2_end: e.target.value })} className={inputClass} />
              <p className="mt-1 text-xs text-gray-500">
                Set a 2nd shift for a two-shift branch — staff pick which shift they're timing in for, and late
                is measured against it. Leave blank for a single-shift branch.
              </p>
            </div>
          </div>

          <div className="mt-4">
            <label className={labelClass}>Working days (attendance is expected on these days)</label>
            <div className="mt-2 flex gap-2">
              {DAY_LABELS.map((label, i) => {
                const day = i + 1;
                const active = form.work_days.includes(day);
                return (
                  <button
                    key={day}
                    type="button"
                    onClick={() => toggleDay(day)}
                    className={
                      active
                        ? 'rounded-lg bg-brand-500 px-3 py-1.5 text-sm font-medium text-on-gold'
                        : 'rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100'
                    }
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
          <label className="mt-4 flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={form.is_active}
              onChange={(e) => setForm({ ...form, is_active: e.target.checked })}
            />
            Active
          </label>

          {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

          <div className="mt-4 flex gap-2">
            <button
              type="submit"
              disabled={busy}
              className="btn-primary"
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              onClick={() => setEditingId(null)}
              className="btn"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {recompute && (
        <div className="mt-4 card p-6">
          <h3 className="text-sm font-semibold text-gray-900">
            Recompute pending days — {recompute.branch.name}
          </h3>
          <p className="mt-1 text-sm text-gray-500">
            Re-runs the attendance engine after a schedule change. Only days still pending review
            are recomputed; approved and corrected days are never touched.
          </p>
          <div className="mt-3 flex items-end gap-3">
            <div>
              <label className={labelClass}>From</label>
              <input type="date" value={recompute.from} onChange={(e) => setRecompute({ ...recompute, from: e.target.value })} className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>To</label>
              <input type="date" value={recompute.to} onChange={(e) => setRecompute({ ...recompute, to: e.target.value })} className={inputClass} />
            </div>
            <button
              onClick={runRecompute}
              disabled={recomputeBusy}
              className="btn-primary"
            >
              {recomputeBusy ? 'Recomputing…' : 'Recompute'}
            </button>
            <button
              onClick={() => setRecompute(null)}
              className="btn"
            >
              Close
            </button>
          </div>
          {recomputeMsg && (
            <p className={`mt-3 text-sm ${recomputeMsg.startsWith('Error') ? 'text-red-600' : 'text-green-700'}`}>
              {recomputeMsg}
            </p>
          )}
        </div>
      )}

      <div className="mt-4 overflow-hidden card">
        <table className="w-full text-left text-sm">
          <thead className="bg-ground text-muted">
            <tr>
              <th className="px-4 py-2 font-medium">Branch</th>
              <th className="px-4 py-2 font-medium">Address</th>
              <th className="px-4 py-2 font-medium">Coordinates</th>
              <th className="px-4 py-2 font-medium">Schedule</th>
              <th className="px-4 py-2 font-medium">Geofence</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {branches.map((b) => (
              <tr key={b.id} className="hover:bg-gray-50">
                <td className="px-4 py-2 font-medium text-gray-900">{b.name}</td>
                <td className="px-4 py-2 text-gray-600">{b.address ?? '—'}</td>
                <td className="px-4 py-2 font-mono text-xs text-gray-600">
                  {b.lat.toFixed(4)}, {b.lng.toFixed(4)}
                </td>
                <td className="px-4 py-2 text-xs text-gray-600">
                  {formatShift(b.shift_start, b.shift_end)}
                  {b.shift2_start && b.shift2_end && ` + ${formatShift(b.shift2_start, b.shift2_end)}`} ·{' '}
                  {(b.work_days ?? []).map((d) => DAY_LABELS[d - 1]).join(' ')}
                </td>
                <td className="px-4 py-2 text-gray-600">{b.geofence_radius_m} m</td>
                <td className="px-4 py-2">
                  <span
                    className={
                      b.is_active
                        ? 'rounded-full bg-green-100 px-2 py-0.5 text-xs text-green-700'
                        : 'rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500'
                    }
                  >
                    {b.is_active ? 'Active' : 'Inactive'}
                  </span>
                </td>
                <td className="px-4 py-2 text-right">
                  <button onClick={() => startEdit(b)} className="text-sm text-brand-700 hover:underline">
                    Edit
                  </button>
                  <button onClick={() => startRecompute(b)} className="ml-3 text-sm text-gray-500 hover:underline">
                    Recompute
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
